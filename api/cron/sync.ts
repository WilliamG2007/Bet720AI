/**
 * Vercel cron endpoint — auto-syncs live World Cup matches and resolves
 * any predictions for matches that have finished. Runs even when nobody
 * is on the site, so points settle within minutes of the final whistle.
 *
 * Also delegates to /api/sync/matches every tick to refresh ODDS on
 * upcoming fixtures so newly-added scheduled matches never sit at
 * NULL odds waiting for a user page-load to price them.
 *
 * Required env vars (configure in Vercel project settings):
 *   FOOTBALL_API_KEY       — football-data.org token
 *   SUPABASE_URL           — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE  — service-role key (bypasses RLS — server-only)
 *
 * Scheduled via vercel.json `crons` entry. Vercel cron may also POST a
 * Bearer header — we don't gate on it because the work is idempotent and
 * the endpoint exposes no sensitive output.
 */
export const config = { runtime: 'edge' }

const FD_BASE       = 'https://api.football-data.org/v4'
const WC_ID         = 2000
const MAX_LIVE_MS   = 3.5 * 60 * 60 * 1000

interface FDMatch {
  id: number
  utcDate: string
  status: 'SCHEDULED' | 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED' | 'SUSPENDED' | 'POSTPONED' | 'CANCELLED'
  matchday: number
  stage: string
  group: string | null
  homeTeam: { id: number; name: string; shortName: string; tla: string; crest: string }
  awayTeam: { id: number; name: string; shortName: string; tla: string; crest: string }
  score: { fullTime: { home: number | null; away: number | null }; halfTime: { home: number | null; away: number | null } }
  competition: { id: number; name: string; code: string }
  season: { startDate: string; endDate: string; currentMatchday: number }
}

function mapStatus(s: FDMatch['status']): 'scheduled' | 'live' | 'finished' | 'postponed' {
  if (s === 'FINISHED') return 'finished'
  if (s === 'IN_PLAY' || s === 'PAUSED') return 'live'
  if (s === 'POSTPONED' || s === 'CANCELLED' || s === 'SUSPENDED') return 'postponed'
  return 'scheduled'
}

function fdToRow(m: FDMatch) {
  return {
    external_id:  m.id,
    home_team:    m.homeTeam.shortName || m.homeTeam.name,
    away_team:    m.awayTeam.shortName || m.awayTeam.name,
    home_crest:   m.homeTeam.crest ?? null,
    away_crest:   m.awayTeam.crest ?? null,
    competition:  m.competition.name,
    kickoff_at:   m.utcDate,
    status:       mapStatus(m.status),
    home_score:   m.score.fullTime.home ?? null,
    away_score:   m.score.fullTime.away ?? null,
    matchday:     m.matchday ?? null,
    season:       m.season?.startDate?.substring(0, 4) ?? null,
    stage:        m.stage ?? null,
    group:        m.group ?? null,
    updated_at:   new Date().toISOString(),
  }
}

async function fdFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${FD_BASE}${path}`, { headers: { 'X-Auth-Token': apiKey } })
  if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
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

async function sbSelectLiveIds(sbUrl: string, key: string): Promise<{ id: string; external_id: number; kickoff_at: string }[]> {
  const url = `${sbUrl}/rest/v1/matches?select=id,external_id,kickoff_at&status=eq.live&competition=eq.FIFA%20World%20Cup`
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`supabase select ${res.status}: ${await res.text()}`)
  return res.json()
}

async function sbResolve(sbUrl: string, key: string, matchId: string) {
  const res = await fetch(`${sbUrl}/rest/v1/rpc/resolve_predictions`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_match_id: matchId }),
  })
  if (!res.ok) throw new Error(`supabase rpc ${res.status}: ${await res.text()}`)
}

async function sbCallRpc(sbUrl: string, key: string, fn: string): Promise<unknown> {
  const res = await fetch(`${sbUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  if (!res.ok) throw new Error(`supabase rpc ${fn} ${res.status}: ${await res.text()}`)
  return res.json().catch(() => null)
}

export default async function handler(req: Request): Promise<Response> {
  const apiKey = process.env.FOOTBALL_API_KEY ?? ''
  const sbUrl  = process.env.SUPABASE_URL ?? ''
  const sbKey  = process.env.SUPABASE_SERVICE_ROLE ?? ''
  const secret = process.env.CRON_SECRET ?? ''

  // Require a shared secret so the public endpoint can't be hammered.
  // GitHub Actions sends `Authorization: Bearer ${{ secrets.CRON_SECRET }}`.
  if (secret) {
    const auth = req.headers.get('authorization') ?? ''
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }
  }

  if (!apiKey || !sbUrl || !sbKey) {
    return new Response(JSON.stringify({ error: 'missing env vars' }), { status: 500 })
  }

  const stats = { liveUpserted: 0, finishedUpserted: 0, resolved: 0, forced: 0, remindersSent: 0, upcomingSynced: false, errors: [] as string[] }

  // 0) Refresh upcoming scheduled matches + odds via the public sync endpoint.
  // Same Vercel deployment, so the round-trip is effectively in-process.
  // Done first so the live/finished pass below sees any newly-listed fixtures.
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/sync/matches`, { method: 'POST' })
    if (r.ok) stats.upcomingSynced = true
    else stats.errors.push(`upcoming sync ${r.status}: ${(await r.text()).slice(0, 200)}`)
  } catch (e) {
    stats.errors.push(`upcoming sync: ${(e as Error).message}`)
  }

  try {
    // 1) Upsert currently in-play WC matches
    const live = await fdFetch<{ matches: FDMatch[] }>(`/competitions/${WC_ID}/matches?status=IN_PLAY,PAUSED`, apiKey)
    const liveRows = live.matches.map(fdToRow)
    await sbUpsert(sbUrl, sbKey, liveRows)
    stats.liveUpserted = liveRows.length

    // 2) Reconcile stale-live rows: DB-live but API says otherwise OR past 3.5h ceiling
    const liveIds = new Set(live.matches.map(m => m.id))
    const dbLive = await sbSelectLiveIds(sbUrl, sbKey)
    const now = Date.now()
    for (const m of dbLive) {
      const ageMs = now - new Date(m.kickoff_at).getTime()
      const stuckTooLong = ageMs > MAX_LIVE_MS
      const apiSaysOver  = !liveIds.has(m.external_id)
      if (!stuckTooLong && !apiSaysOver) continue
      try {
        const fresh = await fdFetch<FDMatch>(`/matches/${m.external_id}`, apiKey)
        const row: Record<string, unknown> = fdToRow(fresh)
        if (stuckTooLong) { row.status = 'finished'; stats.forced++ }
        await sbUpsert(sbUrl, sbKey, [row])
        if (row.status === 'finished') {
          await sbResolve(sbUrl, sbKey, m.id)
          stats.resolved++
        }
      } catch (e) {
        stats.errors.push(`reconcile ${m.external_id}: ${(e as Error).message}`)
      }
    }

    // 3) Pull yesterday/today finished matches and resolve their predictions
    const today     = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const finished  = await fdFetch<{ matches: FDMatch[] }>(
      `/competitions/${WC_ID}/matches?status=FINISHED&dateFrom=${yesterday}&dateTo=${today}`, apiKey
    )
    const finishedRows = finished.matches.map(fdToRow)
    await sbUpsert(sbUrl, sbKey, finishedRows)
    stats.finishedUpserted = finishedRows.length

    if (finished.matches.length) {
      const ids = finished.matches.map(m => m.id).join(',')
      const url = `${sbUrl}/rest/v1/matches?select=id&external_id=in.(${ids})`
      const idsRes = await fetch(url, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } })
      const idRows = (await idsRes.json()) as { id: string }[]
      for (const r of idRows) {
        try {
          await sbResolve(sbUrl, sbKey, r.id)
          stats.resolved++
        } catch (e) {
          stats.errors.push(`resolve ${r.id}: ${(e as Error).message}`)
        }
      }
    }
    // 4) Fire kickoff reminders for predictions on matches starting in 10-20 min
    try {
      const sent = await sbCallRpc(sbUrl, sbKey, 'send_kickoff_reminders')
      if (typeof sent === 'number') stats.remindersSent = sent
    } catch (e) {
      stats.errors.push(`reminders: ${(e as Error).message}`)
    }
  } catch (e) {
    stats.errors.push((e as Error).message)
    return new Response(JSON.stringify(stats), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify(stats), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
