import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import type { League } from '../types/database'

interface LeagueContextValue {
  leagues: League[]
  activeLeague: League | null
  setActiveLeague: (l: League | null) => void
  loading: boolean
  reload: () => Promise<void>
}

const LeagueContext = createContext<LeagueContextValue | null>(null)

export function LeagueProvider({ children }: { children: ReactNode }) {
  const { authUser } = useAuth()
  const [leagues, setLeagues] = useState<League[]>([])
  const [activeLeague, setActiveLeague] = useState<League | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (!authUser) { setLeagues([]); setActiveLeague(null); return }
    setLoading(true)
    const { data } = await supabase
      .from('league_members')
      .select('league_id, leagues(*)')
      .eq('user_id', authUser.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = ((data ?? []) as any[]).map((row: { leagues: League | League[] }) =>
      Array.isArray(row.leagues) ? row.leagues[0] : row.leagues
    ).filter(Boolean) as League[]
    setLeagues(ls)
    if (ls.length > 0 && !activeLeague) setActiveLeague(ls[0])
    setLoading(false)
  }

  useEffect(() => { load() }, [authUser])

  return (
    <LeagueContext.Provider value={{ leagues, activeLeague, setActiveLeague, loading, reload: load }}>
      {children}
    </LeagueContext.Provider>
  )
}

export function useLeague() {
  const ctx = useContext(LeagueContext)
  if (!ctx) throw new Error('useLeague must be used within LeagueProvider')
  return ctx
}
