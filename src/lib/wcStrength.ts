/**
 * World Cup team-strength ratings.
 *
 * Tournaments have no league standings, so the Poisson model has no
 * attack/defense data to work from — every match would otherwise use the
 * same neutral expected goals. This module assigns each nation an overall
 * strength scalar (loosely based on FIFA ranking / Elo tiers) and converts a
 * matchup into expected goals, so e.g. Germany is correctly favoured over
 * Ivory Coast.
 */
import { computeMatchOdds, DEFAULT_MATCH_ODDS, type MatchOdds, type TeamStrengths } from './poissonOdds'
import type { Match } from '../types/database'

// Neutral-venue baseline goals for an evenly-matched tie.
const BASE_HOME = 1.35
const BASE_AWAY = 1.25

// Overall strength scalar per nation (≈0.7 minnow … ≈1.75 elite).
// Keys are normalised (lowercase, accent-stripped, alnum only).
const RATINGS: Record<string, number> = {
  argentina: 1.75, france: 1.72, spain: 1.68, england: 1.62, brazil: 1.66,
  portugal: 1.5, netherlands: 1.48, germany: 1.46, belgium: 1.42, croatia: 1.38,
  italy: 1.48, uruguay: 1.32, colombia: 1.28, morocco: 1.3, switzerland: 1.22,
  denmark: 1.24, japan: 1.2, senegal: 1.22, usa: 1.18, mexico: 1.16,
  southkorea: 1.1, ecuador: 1.08, serbia: 1.12, poland: 1.1, austria: 1.14,
  sweden: 1.08, ukraine: 1.06, wales: 1.04, australia: 0.95, canada: 1.0,
  ivorycoast: 0.92, nigeria: 0.98, ghana: 0.9, cameroon: 0.9, tunisia: 0.88,
  algeria: 1.0, egypt: 1.02, qatar: 0.82, iran: 1.0, saudiarabia: 0.85,
  iraq: 0.8, jordan: 0.78, uzbekistan: 0.82, costarica: 0.9, panama: 0.86,
  honduras: 0.8, jamaica: 0.82, paraguay: 1.0, peru: 0.98, chile: 1.02,
  bolivia: 0.78, venezuela: 0.92, newzealand: 0.78, southafrica: 0.88,
  capeverde: 0.82, angola: 0.8,
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '')
}

// Aliases for naming variants returned by football-data.org.
const ALIASES: Record<string, string> = {
  cotedivoire: 'ivorycoast',
  korearepublic: 'southkorea',
  korea: 'southkorea',
  usmnt: 'usa',
  unitedstates: 'usa',
  irrofiran: 'iran',
}

export function teamRating(name: string): number {
  const key = normalize(name)
  return RATINGS[ALIASES[key] ?? key] ?? 1.0 // unknown → average
}

/** Pre-match odds for a World Cup fixture from the two teams' ratings. */
export function computeWcOdds(homeTeam: string, awayTeam: string): MatchOdds {
  const rHome = teamRating(homeTeam)
  const rAway = teamRating(awayTeam)

  // A stronger side scores more and concedes less. Build TeamStrengths so the
  // existing Poisson engine produces expected goals scaled by the rating gap.
  const home: TeamStrengths = {
    attackHome: rHome, defenseHome: 1 / rHome,
    attackAway: rHome, defenseAway: 1 / rHome,
  }
  const away: TeamStrengths = {
    attackHome: rAway, defenseHome: 1 / rAway,
    attackAway: rAway, defenseAway: 1 / rAway,
  }

  // leagueAvg here is the neutral-venue baseline; homeExp = rHome/rAway * BASE.
  return computeMatchOdds(home, away, BASE_HOME, BASE_AWAY)
}

/**
 * Best-effort pre-match odds when a row hasn't been priced yet (NULL DB odds).
 *
 * For FIFA World Cup matches we recompute from nation-strength ratings, so the
 * UI never shows the 2.15/3.40/3.60 DEFAULT_MATCH_ODDS fallback. The same
 * function is mirrored server-side in api/sync/matches.ts so the odds the
 * user sees in the modal are the odds place_bet settles against.
 *
 * For non-WC matches without standings data, fall back to neutral defaults
 * (we have no team-strength tables for those leagues yet).
 */
export function clientFallbackOdds(match: Pick<Match, 'competition' | 'home_team' | 'away_team'>): MatchOdds {
  if (match.competition === 'FIFA World Cup') {
    return computeWcOdds(match.home_team, match.away_team)
  }
  return DEFAULT_MATCH_ODDS
}
