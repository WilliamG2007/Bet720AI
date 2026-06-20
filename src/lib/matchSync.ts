/**
 * Sync matches from football-data.org into Supabase.
 * Also fetches standings to compute Poisson-based odds per match.
 */
import { supabase } from './supabase'
import { COMPETITIONS, fetchUpcomingMatches, fetchStandings, fdMatchToDbMatch } from './footballApi'
import type { FDStandingEntry } from './footballApi'
import { parseStandings, computeMatchOdds, DEFAULT_MATCH_ODDS } from './poissonOdds'
import type { StandingEntry } from './poissonOdds'
import { computeWcOdds } from './wcStrength'
import { format, addDays } from 'date-fns'
import { fetchMatch } from './footballApi'

const SYNC_COMPETITIONS = [
  COMPETITIONS.WC.id,   // World Cup — always first, live right now
  COMPETITIONS.PL.id,
  COMPETITIONS.CL.id,
  COMPETITIONS.SA.id,
]

// Competitions without standings (tournaments) — use default Poisson odds
const NO_STANDINGS = new Set<number>([COMPETITIONS.WC.id])

function toStandingEntry(e: FDStandingEntry): StandingEntry {
  return {
    teamId:        e.team.id,
    playedGames:   e.playedGames,
    goalsFor:      e.goalsFor,
    goalsAgainst:  e.goalsAgainst,
  }
}

async function syncCompetition(compId: number, dateFrom: string, dateTo: string): Promise<void> {
  // WC and cup competitions have no standings — skip standings fetch
  const [matches, standings] = await Promise.all([
    fetchUpcomingMatches(compId, dateFrom, dateTo).catch(() => []),
    NO_STANDINGS.has(compId) ? Promise.resolve(null) : fetchStandings(compId).catch(() => null),
  ])

  if (!matches.length) return

  // Build team strength map if standings available
  const standingsData = standings
    ? parseStandings(standings.home.map(toStandingEntry), standings.away.map(toStandingEntry))
    : null

  const rows = matches.map(m => {
    const base = fdMatchToDbMatch(m)

    // Compute Poisson odds from standings
    const homeStr = standingsData?.teamStrengths.get(m.homeTeam.id)
    const awayStr = standingsData?.teamStrengths.get(m.awayTeam.id)

    const odds = (homeStr && awayStr && standingsData)
      ? computeMatchOdds(homeStr, awayStr, standingsData.leagueAvgHome, standingsData.leagueAvgAway)
      : NO_STANDINGS.has(compId)
        ? computeWcOdds(base.home_team, base.away_team) // tournament: rate by nation
        : DEFAULT_MATCH_ODDS

    return {
      ...base,
      home_odds:            odds.home,
      draw_odds:            odds.draw,
      away_odds:            odds.away,
      btts_yes_odds:        odds.bttsYes,
      btts_no_odds:         odds.bttsNo,
      expected_home_goals:  odds.homeExpected,
      expected_away_goals:  odds.awayExpected,
    }
  }) as Record<string, unknown>[]

  const { error } = await supabase
    .from('matches')
    .upsert(rows, { onConflict: 'external_id' })

  if (error) console.error(`Sync error (comp ${compId}):`, error)
}

export async function syncUpcomingMatches(): Promise<void> {
  const today   = format(new Date(), 'yyyy-MM-dd')
  const weekOut = format(addDays(new Date(), 7), 'yyyy-MM-dd')

  // Sequential to stay under 10 req/min (2 requests per competition)
  for (const compId of SYNC_COMPETITIONS) {
    try {
      await syncCompetition(compId, today, weekOut)
    } catch (e) {
      console.error(`Failed to sync competition ${compId}:`, e)
    }
  }
}

export async function syncLiveMatches(): Promise<void> {
  const { data: liveRaw } = await supabase
    .from('matches')
    .select('external_id, id')
    .eq('status', 'live')

  const liveMatches = (liveRaw ?? []) as { external_id: number; id: string }[]
  if (!liveMatches.length) return

  for (const m of liveMatches) {
    try {
      const match = await fetchMatch(m.external_id)
      const row = fdMatchToDbMatch(match) as Record<string, unknown>

      await supabase
        .from('matches')
        .upsert(row, { onConflict: 'external_id' })

      if (row.status === 'finished') {
        await supabase.rpc('resolve_predictions', { p_match_id: m.id })
      }
    } catch (e) {
      console.error(`Failed to sync live match ${m.external_id}:`, e)
    }
  }
}
