/**
 * Market: Exact score. Selection is the final scoreline encoded as 'H-A'
 * (matches the legacy predictions.predicted_value format so migration is a
 * trivial string copy).
 *
 * The UI currently lets the user type any score and previews odds via
 * exactScoreDecimalOdds — that interaction stays, but for the registry's
 * `enumerate` (used by the future "browse markets" panel) we surface a
 * 4×4 grid of the most likely scorelines (0–3 home × 0–3 away). Anything
 * with decimalOdds >= 100 is unbettable and filtered out — naturally
 * cleans up "can't un-score" entries for live matches.
 *
 * exactScoreDecimalOdds handles both pre-match (curHome=curAway=0) and live
 * (curHome/curAway = current score) — same fn the existing SQL dispatcher
 * calls via the public.exact_score_decimal wrapper.
 */

import { exactScoreDecimalOdds } from '../poissonOdds'
import { registerMarket } from './registry'
import type {
  LegStatus,
  MarketDef,
  MarketDisplay,
  MatchFacts,
  MatchPricingInputs,
  Selection,
} from './types'

/** Browsable grid edge — show 0..N goals per side in the enumerate output. */
const GRID_MAX = 3
/** Selections priced above this in `enumerate` are dropped (effectively unbettable). */
const ENUMERATE_DECIMAL_CAP = 100

function parseSelection(selection: string): { h: number; a: number } | null {
  const parts = selection.split('-')
  if (parts.length !== 2) return null
  const h = Number(parts[0])
  const a = Number(parts[1])
  if (!Number.isInteger(h) || !Number.isInteger(a)) return null
  if (h < 0 || a < 0) return null
  return { h, a }
}

export const exactScoreMarket: MarketDef = {
  type: 'exact_score',

  enumerate(match: MatchPricingInputs): MarketDisplay[] {
    const curHome = match.homeScore ?? 0
    const curAway = match.awayScore ?? 0
    const selections: Selection[] = []
    for (let h = 0; h <= GRID_MAX; h++) {
      for (let a = 0; a <= GRID_MAX; a++) {
        const dec = exactScoreDecimalOdds(
          match.expectedHomeGoals,
          match.expectedAwayGoals,
          h, a,
          match.status === 'live' ? curHome : 0,
          match.status === 'live' ? curAway : 0,
        )
        if (dec >= ENUMERATE_DECIMAL_CAP) continue
        selections.push({
          selection:   `${h}-${a}`,
          label:       `${h}–${a}`,
          decimalOdds: dec,
        })
      }
    }
    if (!selections.length) return []
    return [{
      marketType: 'exact_score',
      params: {},
      title: 'Exact score',
      selections,
    }]
  },

  price(match: MatchPricingInputs, _params, selection): number {
    const parsed = parseSelection(selection)
    if (!parsed) return 200
    const curHome = match.homeScore ?? 0
    const curAway = match.awayScore ?? 0
    return exactScoreDecimalOdds(
      match.expectedHomeGoals,
      match.expectedAwayGoals,
      parsed.h, parsed.a,
      match.status === 'live' ? curHome : 0,
      match.status === 'live' ? curAway : 0,
    )
  },

  grade(facts: MatchFacts, _params, selection): LegStatus {
    const parsed = parseSelection(selection)
    if (!parsed) return 'void'
    return (parsed.h === facts.homeScore && parsed.a === facts.awayScore) ? 'won' : 'lost'
  },
}

registerMarket(exactScoreMarket)
