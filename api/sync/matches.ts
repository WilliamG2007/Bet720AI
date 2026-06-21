/**
 * Public match-sync endpoint. The frontend's "Sync now" button hits this
 * instead of writing to Supabase directly — once secure_bets.sql ran, the
 * matches table is INSERT/UPDATE-locked to the service role.
 *
 * Idempotent: it pulls fixtures from football-data.org, computes Poisson /
 * WC-strength odds, and upserts. Safe to hammer; football-data's free-tier
 * rate limit (10 req/min) is the real ceiling.
 *
 * Required env vars (same set as api/cron/sync.ts):
 *   FOOTBALL_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE
 */
import { COMPETITIONS, fetchUpcomingMatches, fetchStandings, fdMatchToDbMatch } from '../../src/lib/footballApi'
import type { FDStandingEntry } from '../../src/lib/footballApi'
import { parseStandings, computeMatchOdds, DEFAULT_MATCH_ODDS } from '../../src/lib/poissonOdds'
import type { StandingEntry } from '../../src/lib/poissonOdds'
import { computeWcOdds } from '../../src/lib/wcStrength'

export const config = { runtime: 'edge' }

const SYNC_COMPETITIONS = [
  COMPETITIONS.WC.id,
  COMPETITIONS.PL.id,
  COMPETITIONS.CL.id,
  COMPETITIONS.SA.id,
]
const NO_STANDINGS = new Set<number>([COMPETITIONS.WC.id])

function toStandingEntry(e: FDStandingEntry): StandingEntry {
  return {
    teamId:       e.team.id,
    playedGames:  e.playedGames,
    goalsFor:     e.goalsFor,
    goalsAgainst: e.goalsAgainst,
  }
}

async function sbUpsert(sbUrl: string, key: string, rows: unknown[]) {
  if (!rows.length) return
  const res = await fetch(`${sbUrl}/rest/v1/matches?on_conflict=external_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`supabase upsert ${res.status}: ${await res.text()}`)
}

async function syncCompetition(compId: number, sbUrl: string, sbKey: string): Promise<number> {
  const today   = new Date().toISOString().slice(0, 10)
  const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  // For the World Cup, sync the whole tournament window so all upcoming
  // groups/knockout fixtures get odds, not just the next 7 days.
  const dateTo  = compId === COMPETITIONS.WC.id ? '2026-07-19' : weekOut

  const [matches, standingsCurrent] = await Promise.all([
    fetchUpcomingMatches(compId, today, dateTo).catch(() => []),
    NO_STANDINGS.has(compId) ? Promise.resolve(null) : fetchStandings(compId).catch(() => null),
  ])
  if (!matches.length) return 0

  // Fall back to previous season's standings when the current table is too
  // sparse (early in the season) — matches the logic in src/lib/matchSync.ts.
  let standings = standingsCurrent
  const tooSparse = standings && (() => {
    const sample = [...standings.home, ...standings.away]
    if (!sample.length) return true
    const maxPlayed = Math.max(...sample.map(e => e.playedGames))
    return maxPlayed < 5
  })()
  if (!NO_STANDINGS.has(compId) && (!standings || tooSparse)) {
    const prev = await fetchStandings(compId, String(new Date().getUTCFullYear() - 1)).catch(() => null)
    if (prev) standings = prev
  }

  const standingsData = standings
    ? parseStandings(standings.home.map(toStandingEntry), standings.away.map(toStandingEntry))
    : null

  const rows = matches.map(m => {
    const base = fdMatchToDbMatch(m)
    const homeStr = standingsData?.teamStrengths.get(m.homeTeam.id)
    const awayStr = standingsData?.teamStrengths.get(m.awayTeam.id)
    const odds = (homeStr && awayStr && standingsData)
      ? computeMatchOdds(homeStr, awayStr, standingsData.leagueAvgHome, standingsData.leagueAvgAway)
      : NO_STANDINGS.has(compId)
        ? computeWcOdds(base.home_team, base.away_team)
        : DEFAULT_MATCH_ODDS
    return {
      ...base,
      home_odds:           odds.home,
      draw_odds:           odds.draw,
      away_odds:           odds.away,
      btts_yes_odds:       odds.bttsYes,
      btts_no_odds:        odds.bttsNo,
      expected_home_goals: odds.homeExpected,
      expected_away_goals: odds.awayExpected,
    }
  })

  await sbUpsert(sbUrl, sbKey, rows)
  return rows.length
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 })
  }

  const sbUrl = process.env.SUPABASE_URL ?? ''
  const sbKey = process.env.SUPABASE_SERVICE_ROLE ?? ''
  if (!sbUrl || !sbKey) {
    return new Response(JSON.stringify({ error: 'missing env vars' }), { status: 500 })
  }

  // Optional: ?comp=WC | PL | CL | SA — single-competition sync. Defaults
  // to all four. Useful when the user clicks "Sync now" on the WC page and
  // we don't need to refresh league standings too.
  const url = new URL(req.url)
  const compParam = url.searchParams.get('comp')
  const targets = compParam && compParam in COMPETITIONS
    ? [COMPETITIONS[compParam as keyof typeof COMPETITIONS].id]
    : SYNC_COMPETITIONS

  const stats: Record<string, number | string> = {}
  for (const compId of targets) {
    try {
      stats[`comp_${compId}`] = await syncCompetition(compId, sbUrl, sbKey)
    } catch (e) {
      stats[`error_${compId}`] = (e as Error).message
    }
  }

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
