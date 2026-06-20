/**
 * football-data.org API client
 * Free tier: 10 req/min, competitions: PL, BL1, SA, PD, FL1, CL, EC
 */

// All requests go through our own /fd-api proxy (Vite dev proxy locally,
// Vercel edge function in prod) to bypass football-data.org's CORS policy,
// which returns Access-Control-Allow-Origin without a port and is rejected
// by browsers. The proxy attaches the API key server-side.
const BASE_URL = '/fd-api'

// Competition IDs on football-data.org
export const COMPETITIONS = {
  PL:  { id: 2021, name: 'Premier League',    code: 'PL'  },
  BL1: { id: 2002, name: 'Bundesliga',         code: 'BL1' },
  SA:  { id: 2019, name: 'Serie A',             code: 'SA'  },
  PD:  { id: 2014, name: 'La Liga',             code: 'PD'  },
  FL1: { id: 2015, name: 'Ligue 1',             code: 'FL1' },
  CL:  { id: 2001, name: 'Champions League',    code: 'CL'  },
  WC:  { id: 2000, name: 'FIFA World Cup',      code: 'WC'  },
} as const

async function apiFetch<T>(path: string): Promise<T> {
  // No auth header here — the proxy injects X-Auth-Token server-side.
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`football-data.org ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export interface FDMatch {
  id: number
  utcDate: string
  status: 'SCHEDULED' | 'TIMED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED' | 'SUSPENDED' | 'POSTPONED' | 'CANCELLED'
  matchday: number
  stage: string
  group: string | null
  homeTeam: { id: number; name: string; shortName: string; tla: string; crest: string }
  awayTeam: { id: number; name: string; shortName: string; tla: string; crest: string }
  score: {
    fullTime: { home: number | null; away: number | null }
    halfTime: { home: number | null; away: number | null }
  }
  competition: { id: number; name: string; code: string }
  season: { startDate: string; endDate: string; currentMatchday: number }
}

interface FDMatchesResponse {
  matches: FDMatch[]
}

function mapStatus(s: FDMatch['status']): 'scheduled' | 'live' | 'finished' | 'postponed' {
  if (s === 'FINISHED') return 'finished'
  if (s === 'IN_PLAY' || s === 'PAUSED') return 'live'
  if (s === 'POSTPONED' || s === 'CANCELLED' || s === 'SUSPENDED') return 'postponed'
  return 'scheduled'
}

export function fdMatchToDbMatch(m: FDMatch) {
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

/** Fetch upcoming + recent matches for a competition (next 7 days by default) */
export async function fetchCompetitionMatches(competitionId: number): Promise<FDMatch[]> {
  const { matches } = await apiFetch<FDMatchesResponse>(`/competitions/${competitionId}/matches?status=SCHEDULED,TIMED,IN_PLAY,FINISHED`)
  return matches
}

/** Fetch a single match by external id */
export async function fetchMatch(matchId: number): Promise<FDMatch> {
  return apiFetch<FDMatch>(`/matches/${matchId}`)
}

/** Fetch all live + just-finished matches for a competition (for in-play updates) */
export async function fetchLiveCompetitionMatches(competitionId: number): Promise<FDMatch[]> {
  const { matches } = await apiFetch<FDMatchesResponse>(
    `/competitions/${competitionId}/matches?status=IN_PLAY,PAUSED,FINISHED`
  )
  return matches
}

/** Fetch today + next N days of matches across competitions */
export async function fetchUpcomingMatches(competitionId: number, dateFrom: string, dateTo: string): Promise<FDMatch[]> {
  const { matches } = await apiFetch<FDMatchesResponse>(
    `/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
  )
  return matches
}

export interface FDStandingEntry {
  team: { id: number; name: string; shortName: string }
  playedGames: number
  won: number
  draw: number
  lost: number
  goalsFor: number
  goalsAgainst: number
}

interface FDStandingsResponse {
  standings: Array<{
    type: 'TOTAL' | 'HOME' | 'AWAY'
    table: FDStandingEntry[]
  }>
}

/** Fetch HOME + AWAY standings splits for a competition */
export async function fetchStandings(competitionId: number, season?: string): Promise<{
  home: FDStandingEntry[]
  away: FDStandingEntry[]
} | null> {
  try {
    const qs = season ? `?season=${season}` : ''
    const data = await apiFetch<FDStandingsResponse>(`/competitions/${competitionId}/standings${qs}`)
    const home = data.standings.find(s => s.type === 'HOME')?.table ?? []
    const away = data.standings.find(s => s.type === 'AWAY')?.table ?? []
    return home.length && away.length ? { home, away } : null
  } catch {
    return null
  }
}
