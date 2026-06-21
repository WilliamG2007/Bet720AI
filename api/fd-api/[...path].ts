/**
 * Vercel serverless proxy for football-data.org.
 * Bypasses the browser CORS restriction (football-data returns
 * Access-Control-Allow-Origin without a port, which browsers reject).
 *
 * Requests to /fd-api/<anything> are forwarded server-side with the
 * API key attached, so the key never reaches the client either.
 */
export const config = { runtime: 'edge' }

const BASE_URL = 'https://api.football-data.org/v4'

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  // The request arrives as /api/fd-api/<path> (after the vercel.json rewrite).
  // Strip everything up to and including 'fd-api' so we forward only <path>.
  const idx = url.pathname.indexOf('/fd-api')
  const upstreamPath = idx >= 0
    ? url.pathname.slice(idx + '/fd-api'.length)
    : url.pathname
  const upstreamUrl = `${BASE_URL}${upstreamPath}${url.search}`

  const apiKey = process.env.FOOTBALL_API_KEY || process.env.VITE_FOOTBALL_API_KEY || ''

  const res = await fetch(upstreamUrl, {
    headers: { 'X-Auth-Token': apiKey },
  })

  // Live in-play endpoints need fresh data — score/status changes are
  // worthless if they're 60s stale. Cache them only briefly to soak up
  // concurrent identical polls without serving outdated odds.
  const isLive = url.search.includes('status=IN_PLAY') || url.search.includes('status=LIVE')
  const cacheControl = isLive
    ? 's-maxage=8, stale-while-revalidate=15'
    : 's-maxage=60, stale-while-revalidate=120'

  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
    },
  })
}
