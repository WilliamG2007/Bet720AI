/**
 * Market: Over / Under goals. Parameterised by a half-integer line.
 * Selection: 'over' | 'under'. Params: { line: 0.5 | 1.5 | 2.5 | 3.5 | 4.5 }
 *
 * Pre-match: integrate the Poisson joint PMF over (h, a) where h+a > line.
 * Live: H+A ~ Poisson(homeRem + awayRem) (sum of independents). Condition
 * on the current score — if current total already exceeds the line, over
 * is effectively certain.
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

const LINES = [0.5, 1.5, 2.5, 3.5, 4.5]
const MAX_GOALS = 9
const SUM_CAP = 18 // loop ceiling for the live total-goals sum

type OUPick = 'over' | 'under'

function isPick(s: string): s is OUPick {
  return s === 'over' || s === 'under'
}

function preMatchOUProbs(
  homeExp: number,
  awayExp: number,
  line: number,
): { over: number; under: number } {
  let pOver = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(homeExp, h)
    for (let a = 0; a <= MAX_GOALS; a++) {
      if (h + a > line) pOver += ph * poissonPmf(awayExp, a)
    }
  }
  return { over: pOver, under: 1 - pOver }
}

export const ouGoalsMarket: MarketDef = {
  type: 'ou_goals',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    return LINES.map(line => ({
      marketType: 'ou_goals',
      params: { line },
      title: `Goals O/U ${line}`,
      selections: [
        { selection: 'over',  label: `Over ${line}`,  decimalOdds: this.price(match, { line }, 'over') },
        { selection: 'under', label: `Under ${line}`, decimalOdds: this.price(match, { line }, 'under') },
      ],
    }))
  },

  price(match: MatchPricingInputs, params, selection): number {
    if (!isPick(selection)) return 200
    const line = (params as { line?: number }).line ?? 2.5

    if (match.status === 'live') {
      const minute = estimateLiveMinute(match.kickoffAt)
      const minsRemaining = Math.max(4, 90 - minute)
      const remFrac = Math.min(1, minsRemaining / 90)
      const totalRem = (match.expectedHomeGoals + match.expectedAwayGoals) * remFrac
      const currentTotal = (match.homeScore ?? 0) + (match.awayScore ?? 0)

      if (currentTotal > line) {
        // Over already settled
        return selection === 'over' ? 1.01 : 50
      }

      // Goals still needed for over to land
      const goalsNeeded = Math.ceil(line - currentTotal + 0.5)
      let pOver = 0
      for (let k = goalsNeeded; k <= SUM_CAP; k++) pOver += poissonPmf(totalRem, k)
      return toDecimalOdds(selection === 'over' ? pOver : 1 - pOver)
    }

    const { over, under } = preMatchOUProbs(match.expectedHomeGoals, match.expectedAwayGoals, line)
    return toDecimalOdds(selection === 'over' ? over : under)
  },

  grade(facts: MatchFacts, params, selection): LegStatus {
    if (!isPick(selection)) return 'void'
    const line = (params as { line?: number }).line ?? 2.5
    const total = facts.homeScore + facts.awayScore
    if (selection === 'over')  return total > line ? 'won' : 'lost'
    return total < line ? 'won' : 'lost'
  },
}

registerMarket(ouGoalsMarket)
