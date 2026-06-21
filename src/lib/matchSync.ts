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
  const [matches, standingsCurrent] = await Promise.all([
    fetchUpcomingMatches(compId, dateFrom, dateTo).catch(() => []),
    NO_STANDINGS.has(compId) ? Promise.resolve(null) : fetchStandings(compId).catch(() => null),
  ])

  if (!matches.length) return

  // Early-season standings can have <5 games per team — Poisson rates from
  // 1-2 games are pure noise. Fall back to the previous season's standings
  // when the current table is too sparse, so we still avoid the
  // DEFAULT_MATCH_ODDS (2.15/3.40/3.60) flatline for every fixture.
  let standings = standingsCurrent
  const tooSparse = standings && (() => {
    const sample = [...standings.home, ...standings.away]
    if (!sample.length) return true
    const maxPlayed = Math.max(...sample.map(e => e.playedGames))
    return maxPlayed < 5
  })()
  if (!standings || tooSparse) {
    if (!NO_STANDINGS.has(compId)) {
      const prevSeason = String(new Date().getUTCFullYear() - 1)
      const prev = await fetchStandings(compId, prevSeason).catch(() => null)
      if (prev) standings = prev
    }
  }

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
    .select('external_id, id, kickoff_at')
    .eq('status', 'live')

  const liveMatches = (liveRaw ?? []) as { external_id: number; id: string; kickoff_at: string }[]
  if (!liveMatches.length) return

  // football-data.org's free tier sometimes keeps reporting a match as IN_PLAY
  // long after it actually ended. If kickoff was more than ~3.5h ago (well past
  // 90 + HT + stoppage + ET + pens), trust our clock over the stuck upstream
  // status and force the match to finished using the last known score.
  const MAX_LIVE_MS = 3.5 * 60 * 60 * 1000
  const now = Date.now()

  for (const m of liveMatches) {
    try {
      const match = await fetchMatch(m.external_id)
      const row = fdMatchToDbMatch(match) as Record<string, unknown>

      if (now - new Date(m.kickoff_at).getTime() > MAX_LIVE_MS) row.status = 'finished'

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
