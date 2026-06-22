/**
 * Market: Match result (1X2). The bread-and-butter "who wins / draw" bet.
 *
 * Selection keys mirror the existing predictions.predicted_value scheme so
 * the Phase 1 migration of old rows is a no-op string copy:
 *   '1' = home win, 'X' = draw, '2' = away win.
 *
 * Pre-match: integrate the Poisson joint PMF over (home goals, away goals)
 * up to MAX_GOALS, then apply the standard 5% margin via toDecimalOdds.
 *
 * Live: defer to computeLiveOdds, which already does the "goals in the
 * remaining minutes + current score" recompute. Same math the existing
 * compute_bet_multiplier RPC uses in PL/pgSQL — preserved exactly so the
 * Phase 1 SQL dispatcher can mirror this file line-for-line.
 */

import {
  computeLiveOdds,
  estimateLiveMinute,
  poissonPmf,
  toDecimalOdds,
} from '../poissonOdds'
import { registerMarket } from './registry'
import type {
  LegStatus,
  MarketDef,
  MarketDisplay,
  MatchFacts,
  MatchPricingInputs,
} from './types'

const MAX_GOALS = 9

type Pick1x2 = '1' | 'X' | '2'

interface ResultProbabilities {
  home: number
  draw: number
  away: number
}

/** Integrate the Poisson PMF to get P(home wins) / P(draw) / P(away wins). */
function preMatchResultProbs(homeExp: number, awayExp: number): ResultProbabilities {
  let pHome = 0, pDraw = 0, pAway = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(homeExp, h)
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = ph * poissonPmf(awayExp, a)
      if (h > a) pHome += joint
      else if (h === a) pDraw += joint
      else pAway += joint
    }
  }
  // Truncation at MAX_GOALS leaves a sliver unaccounted — normalise.
  const sum = pHome + pDraw + pAway || 1
  return { home: pHome / sum, draw: pDraw / sum, away: pAway / sum }
}

/** Pick the decimal for one 1X2 selection given the full probability vector. */
function decimalFor(probs: ResultProbabilities, selection: Pick1x2): number {
  switch (selection) {
    case '1': return toDecimalOdds(probs.home)
    case 'X': return toDecimalOdds(probs.draw)
    case '2': return toDecimalOdds(probs.away)
  }
}

function isPick(s: string): s is Pick1x2 {
  return s === '1' || s === 'X' || s === '2'
}

export const resultMarket: MarketDef = {
  type: '1x2',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    const prices = ['1', 'X', '2'].map(s =>
      this.price(match, {}, s),
    )
    return [{
      marketType: '1x2',
      params: {},
      title: 'Match result',
      selections: [
        { selection: '1', label: 'Home',  decimalOdds: prices[0] },
        { selection: 'X', label: 'Draw',  decimalOdds: prices[1] },
        { selection: '2', label: 'Away',  decimalOdds: prices[2] },
      ],
    }]
  },

  price(match: MatchPricingInputs, _params, selection): number {
    if (!isPick(selection)) return 200
    if (match.status === 'live') {
      const minute = estimateLiveMinute(match.kickoffAt)
      const live = computeLiveOdds(
        match.expectedHomeGoals,
        match.expectedAwayGoals,
        match.homeScore ?? 0,
        match.awayScore ?? 0,
        minute,
      )
      switch (selection) {
        case '1': return live.home
        case 'X': return live.draw
        case '2': return live.away
      }
    }
    const probs = preMatchResultProbs(match.expectedHomeGoals, match.expectedAwayGoals)
    return decimalFor(probs, selection)
  },

  grade(facts: MatchFacts, _params, selection): LegStatus {
    if (!isPick(selection)) return 'void'
    const actual: Pick1x2 =
      facts.homeScore > facts.awayScore ? '1' :
      facts.homeScore < facts.awayScore ? '2' :
      'X'
    return selection === actual ? 'won' : 'lost'
  },
}

registerMarket(resultMarket)
