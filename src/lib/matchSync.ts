/**
 * Match sync — thin client that delegates to the server-side
 * /api/sync/matches endpoint. We can't write to the matches table from the
 * client anymore (RLS locked it to service-role only in secure_bets.sql),
 * so the endpoint does the football-data.org fetch + odds compute + upsert.
 *
 * The live-match reconciliation that used to live here moved into the
 * cron (api/cron/sync.ts) which runs every 5 minutes.
 */

export async function syncUpcomingMatches(): Promise<void> {
  try {
    const res = await fetch('/api/sync/matches', { method: 'POST' })
    if (!res.ok) console.error('Sync error:', res.status, await res.text())
  } catch (e) {
    console.error('Sync request failed:', e)
  }
}

/** Sync a single competition. Useful for the WC page's "Sync now" button. */
export async function syncCompetitionByCode(code: 'WC' | 'PL' | 'CL' | 'SA'): Promise<void> {
  try {
    const res = await fetch(`/api/sync/matches?comp=${code}`, { method: 'POST' })
    if (!res.ok) console.error('Sync error:', res.status, await res.text())
  } catch (e) {
    console.error('Sync request failed:', e)
  }
}
