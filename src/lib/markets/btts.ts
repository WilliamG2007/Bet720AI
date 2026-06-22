/**
 * Market: Both Teams To Score. Two selections: 'yes' or 'no'.
 *
 * Pre-match: P(yes) = (1 - P(home scores 0)) * (1 - P(away scores 0)).
 * Live: a team that has already scored is locked in; the other side needs
 * ≥1 goal in the remaining minutes. computeLiveOdds already returns BTTS
 * yes/no priced this way — defer to it.
 *
 * Mirrors the existing compute_bet_multiplier 'btts' branch exactly.
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

type BttsPick = 'yes' | 'no'

function isPick(s: string): s is BttsPick {
  return s === 'yes' || s === 'no'
}

function preMatchBttsYesProb(homeExp: number, awayExp: number): number {
  return (1 - poissonPmf(homeExp, 0)) * (1 - poissonPmf(awayExp, 0))
}

export const bttsMarket: MarketDef = {
  type: 'btts',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    return [{
      marketType: 'btts',
      params: {},
      title: 'Both teams to score',
      selections: [
        { selection: 'yes', label: 'Yes', decimalOdds: this.price(match, {}, 'yes') },
        { selection: 'no',  label: 'No',  decimalOdds: this.price(match, {}, 'no')  },
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
      return selection === 'yes' ? live.bttsYes : live.bttsNo
    }
    const pYes = preMatchBttsYesProb(match.expectedHomeGoals, match.expectedAwayGoals)
    return toDecimalOdds(selection === 'yes' ? pYes : 1 - pYes)
  },

  grade(facts: MatchFacts, _params, selection): LegStatus {
    if (!isPick(selection)) return 'void'
    const bothScored = facts.homeScore > 0 && facts.awayScore > 0
    const want = selection === 'yes'
    return want === bothScored ? 'won' : 'lost'
  },
}

registerMarket(bttsMarket)
