/**
 * Generic market types for the bet registry.
 *
 * The old design hardcoded every bettable question (1X2, BTTS, exact score)
 * into seven places: a matches column, a place_bet branch, a resolve branch,
 * a TS union, a UI tab, and so on. That made adding "over/under 2.5" a
 * cross-cutting change and made parlays structurally impossible (one
 * predictions row = one selection).
 *
 * The new model treats every bettable thing as a pluggable `MarketDef`:
 *   • `enumerate(match)`  — what selections to show in the UI
 *   • `price(match, params, selection)`  — decimal odds (server-authoritative
 *     copy lives in SQL; this TS copy is for the client preview)
 *   • `grade(facts, params, selection)`  — won / lost / void after the match
 *
 * Bets are stored in a generic bets + bet_legs schema (Phase 1) so a single
 * is just a 1-leg bet and a parlay is an N-leg bet. Adding a new market is
 * one file in this folder + one branch in the SQL dispatcher.
 *
 * Pure module: no DB, no HTTP, no React.
 */

/** Stable identifier for a kind of market. Add new values as markets ship. */
export type MarketType =
  | '1x2'
  | 'btts'
  | 'exact_score'
  // Phase 2 will register more: 'ou_goals' | 'double_chance' | 'draw_no_bet'
  // | 'ht_result' | 'ht_ft' | 'team_total' | 'winning_margin' | 'odd_even'

/**
 * Per-market-instance parameters. e.g. for `ou_goals` this would be `{line: 2.5}`,
 * for `team_total` `{side: 'home', line: 1.5}`. Persisted as jsonb in `bet_legs.params`.
 */
export type MarketParams = Record<string, string | number | boolean>

/** A single bettable option within a market, priced. */
export interface Selection {
  /** Canonical key written to bet_legs.selection. e.g. 'over', '1', 'X', '2', 'yes'. */
  selection: string
  /** Display label for the UI. */
  label: string
  /** Decimal odds (including 5% house margin). Net-profit multiplier = decimal - 1. */
  decimalOdds: number
}

/**
 * One market instance ready to render: e.g. "Over/Under 2.5" with two selections,
 * or "Exact score" with one selection per visible scoreline. The UI groups selections
 * by `marketType` + `params`.
 */
export interface MarketDisplay {
  marketType: MarketType
  params: MarketParams
  /** Group title shown in the UI, e.g. "Match result", "Over/Under 2.5". */
  title: string
  selections: Selection[]
}

/** Inputs the pricer needs. Pulled from the matches row. */
export interface MatchPricingInputs {
  status: 'scheduled' | 'live' | 'finished' | 'postponed'
  /** Pre-match expected goals for the home side (Poisson lambda for full 90). */
  expectedHomeGoals: number
  /** Pre-match expected goals for the away side. */
  expectedAwayGoals: number
  /** Current score; only meaningful for live (used to reprice). */
  homeScore?: number | null
  awayScore?: number | null
  /** ISO kickoff timestamp — used to estimate the live minute. */
  kickoffAt: string
}

/** Match-result facts the grader sees once the match is finished. */
export interface MatchFacts {
  homeScore: number
  awayScore: number
  /** Half-time score, persisted in `matches.ht_*_score`. Null when unknown. */
  htHomeScore: number | null
  htAwayScore: number | null
}

/** Outcome of grading a single bet leg. */
export type LegStatus = 'won' | 'lost' | 'void'

/**
 * A market definition. Every market type in the catalog exports one of these
 * and registers it via `registerMarket`.
 *
 * The three methods are pure: they take inputs and return values. No I/O.
 * The SQL dispatcher (Phase 1) mirrors `price` and `grade` for server-side
 * authority. The TS copy is what the client uses to preview odds in the UI.
 */
export interface MarketDef<P extends MarketParams = MarketParams> {
  type: MarketType

  /**
   * Produce every market instance + selections to show for this match.
   * For markets with no params (1X2) this returns one MarketDisplay; for
   * parameterised markets (O/U at multiple lines) it can return several.
   * The UI shouldn't show selections with `decimalOdds >= 100` (effectively
   * unbettable) — markets can self-filter inside this function.
   */
  enumerate(match: MatchPricingInputs): MarketDisplay[]

  /**
   * Authoritative price for a single (params, selection). Called by the UI
   * for live preview and (mirrored in SQL) by place_bet_v2 to freeze the
   * leg odds at bet time. Returning >= 100 means "effectively unbettable".
   */
  price(match: MatchPricingInputs, params: P, selection: string): number

  /**
   * Grade a leg against the finished-match facts. Should return 'void' for
   * any selection that cannot be settled (e.g. an HT market when ht scores
   * are missing) rather than throwing.
   */
  grade(facts: MatchFacts, params: P, selection: string): LegStatus
}
