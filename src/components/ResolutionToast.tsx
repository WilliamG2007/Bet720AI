/**
 * Listens for resolved predictions belonging to the current user and pops
 * a short-lived toast in the corner. Wins and losses get distinct styles.
 * Subscribes via Supabase realtime, so notifications arrive while the user
 * is anywhere in the app.
 */
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import type { Bet, Match } from '../types/database'

interface ToastItem {
  id: string
  won: boolean
  points: number
  homeTeam: string
  awayTeam: string
  homeScore: number | null
  awayScore: number | null
}

export function ResolutionToast() {
  const { authUser } = useAuth()
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    if (!authUser) return

    async function push(bet: Bet) {
      // Skip if we already saw this resolution this session
      if (toasts.some(t => t.id === bet.id)) return
      // For a single-leg bet we can look up the match via the leg.
      const { data: legRaw } = await supabase
        .from('bet_legs').select('match_id').eq('bet_id', bet.id).limit(1).single()
      if (!legRaw) return
      const { data: matchRaw } = await supabase
        .from('matches').select('home_team,away_team,home_score,away_score')
        .eq('id', legRaw.match_id).single()
      const m = matchRaw as Pick<Match, 'home_team' | 'away_team' | 'home_score' | 'away_score'> | null
      if (!m) return
      const item: ToastItem = {
        id: bet.id,
        won: (bet.payout ?? 0) > 0,
        points: bet.payout ?? 0,
        homeTeam: m.home_team,
        awayTeam: m.away_team,
        homeScore: m.home_score,
        awayScore: m.away_score,
      }
      setToasts(prev => [...prev, item])
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== item.id))
      }, 6000)
    }

    const channel = supabase
      .channel(`resolutions:${authUser.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bets', filter: `user_id=eq.${authUser.id}` },
        payload => {
          const newRow = payload.new as Bet
          const oldRow = payload.old as Partial<Bet>
          // Only pop when transitioning out of pending
          if (newRow.status !== 'pending' && oldRow.status === 'pending') push(newRow)
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [authUser, toasts])

  if (!toasts.length) return null

  return (
    <div className="fixed top-16 right-3 z-50 flex flex-col gap-2 max-w-[280px] pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`pointer-events-auto card p-3 animate-fade-in border-2 shadow-lg ${
            t.won ? 'border-accent/40 bg-accent/10' : 'border-danger/30 bg-danger/10'
          }`}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className={`text-[10px] font-bold uppercase tracking-widest ${t.won ? 'text-accent' : 'text-danger'}`}>
              {t.won ? 'Bet hit' : 'Bet lost'}
            </span>
            <span className={`font-mono text-base font-bold ${t.won ? 'text-accent' : 'text-danger'}`}>
              {t.points > 0 ? '+' : ''}{t.points}
            </span>
          </div>
          <div className="text-xs text-muted truncate">
            {t.homeTeam} {t.homeScore ?? '-'} – {t.awayScore ?? '-'} {t.awayTeam}
          </div>
        </div>
      ))}
    </div>
  )
}
