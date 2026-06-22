/**
 * Market: Draw No Bet. Selection: '1' (home) | '2' (away).
 *
 * If the match ends in a draw the bet is void — stake refunded. The
 * pricing conditions out draws by computing P(home | not draw) and
 * P(away | not draw), so the decimal odds reflect the head-to-head
 * contest between the two sides ignoring the draw scenario.
 *
 * Grade: draw → 'void'; decisive result → 'won' or 'lost'.
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

type DNBPick = '1' | '2'

function isPick(s: string): s is DNBPick {
  return s === '1' || s === '2'
}

/** P(home wins | no draw), P(away wins | no draw) */
function dnbProbs(
  homeExp: number,
  awayExp: number,
  curHome: number,
  curAway: number,
): { home: number; away: number } {
  let pHome = 0, pAway = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(homeExp, h)
    for (let a = 0; a <= MAX_GOALS; a++) {
      const fh = curHome + h
      const fa = curAway + a
      if (fh === fa) continue // skip draws
      const joint = ph * poissonPmf(awayExp, a)
      if (fh > fa) pHome += joint
      else pAway += joint
    }
  }
  const sum = pHome + pAway || 1
  return { home: pHome / sum, away: pAway / sum }
}

export const drawNoBetMarket: MarketDef = {
  type: 'draw_no_bet',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    return [{
      marketType: 'draw_no_bet',
      params: {},
      title: 'Draw No Bet',
      selections: [
        { selection: '1', label: 'Home (draw refunds)', decimalOdds: this.price(match, {}, '1') },
        { selection: '2', label: 'Away (draw refunds)', decimalOdds: this.price(match, {}, '2') },
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

    const { home, away } = dnbProbs(homeExp, awayExp, curHome, curAway)
    return toDecimalOdds(selection === '1' ? home : away)
  },

  grade(facts: MatchFacts, _params, selection): LegStatus {
    if (!isPick(selection)) return 'void'
    if (facts.homeScore === facts.awayScore) return 'void' // draw → refund
    const homeWins = facts.homeScore > facts.awayScore
    return (selection === '1') === homeWins ? 'won' : 'lost'
  },
}

registerMarket(drawNoBetMarket)
