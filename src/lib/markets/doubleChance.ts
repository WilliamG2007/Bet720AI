/**
 * Market: Double Chance. Selection: '1X' | 'X2' | '12'.
 *
 * 1X = home win or draw  (covers 2 outcomes)
 * X2 = draw or away win
 * 12 = home or away win  (no draw)
 *
 * Pricing: combine the individual 1X2 Poisson probs. These markets always
 * have odds below 2.0 since they cover ≥2/3 of the probability space —
 * that's expected.
 */

import { poissonPmf, toDecimalOdds, estimateLiveMinute } from '../poissonOdds'
import { registerMarket } from './registry'
import type {
  LegStatus,
  MarketDef,
  MarketDisplay,
  MatchFacts,
  MatchPricingInputs,
} from './types'

const MAX_GOALS = 9

type DCPick = '1X' | 'X2' | '12'

function isPick(s: string): s is DCPick {
  return s === '1X' || s === 'X2' || s === '12'
}

interface Probs { home: number; draw: number; away: number }

function computeProbs(
  homeExp: number,
  awayExp: number,
  curHome: number,
  curAway: number,
): Probs {
  let pHome = 0, pDraw = 0, pAway = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(homeExp, h)
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = ph * poissonPmf(awayExp, a)
      const fh = curHome + h
      const fa = curAway + a
      if (fh > fa) pHome += joint
      else if (fh === fa) pDraw += joint
      else pAway += joint
    }
  }
  const sum = pHome + pDraw + pAway || 1
  return { home: pHome / sum, draw: pDraw / sum, away: pAway / sum }
}

function dcProb(pick: DCPick, { home, draw, away }: Probs): number {
  if (pick === '1X') return home + draw
  if (pick === 'X2') return draw + away
  return home + away // '12'
}

export const doubleChanceMarket: MarketDef = {
  type: 'double_chance',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    return [{
      marketType: 'double_chance',
      params: {},
      title: 'Double Chance',
      selections: [
        { selection: '1X', label: '1X · Home or Draw', decimalOdds: this.price(match, {}, '1X') },
        { selection: 'X2', label: 'X2 · Draw or Away', decimalOdds: this.price(match, {}, 'X2') },
        { selection: '12', label: '12 · Home or Away', decimalOdds: this.price(match, {}, '12') },
      ],
    }]
  },

  price(match: MatchPricingInputs, _params, selection): number {
    if (!isPick(selection)) return 200
    const curHome = match.status === 'live' ? (match.homeScore ?? 0) : 0
    const curAway = match.status === 'live' ? (match.awayScore ?? 0) : 0

    const minute = match.status === 'live' ? estimateLiveMinute(match.kickoffAt) : 0
    const minsRemaining = match.status === 'live' ? Math.max(4, 90 - minute) : 90
    const remFrac = Math.min(1, minsRemaining / 90)
    const homeExp = match.expectedHomeGoals * remFrac
    const awayExp = match.expectedAwayGoals * remFrac

    const probs = computeProbs(homeExp, awayExp, curHome, curAway)
    return toDecimalOdds(dcProb(selection, probs))
  },

  grade(facts: MatchFacts, _params, selection): LegStatus {
    if (!isPick(selection)) return 'void'
    const homeWins = facts.homeScore > facts.awayScore
    const draw     = facts.homeScore === facts.awayScore
    const awayWins = facts.homeScore < facts.awayScore
    if (selection === '1X') return (homeWins || draw)  ? 'won' : 'lost'
    if (selection === 'X2') return (draw     || awayWins) ? 'won' : 'lost'
    return (homeWins || awayWins) ? 'won' : 'lost' // '12'
  },
}

registerMarket(doubleChanceMarket)
