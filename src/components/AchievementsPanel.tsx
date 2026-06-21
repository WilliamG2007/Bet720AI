import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Achievement, UserAchievement } from '../types/database'

const TIER_RING: Record<Achievement['tier'], string> = {
  bronze:   'ring-amber-700/40 bg-amber-700/10',
  silver:   'ring-slate-300/40 bg-slate-300/10',
  gold:     'ring-yellow-400/50 bg-yellow-400/10',
  platinum: 'ring-cyan-300/60 bg-cyan-300/10',
}

const TIER_LABEL: Record<Achievement['tier'], string> = {
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum',
}

/**
 * Shows the full achievement catalogue with earned/locked states.
 * Pulls the static catalogue once and joins against user_achievements;
 * realtime subscription bumps the list whenever the award engine
 * unlocks a new one for this user.
 */
export function AchievementsPanel({ userId }: { userId: string }) {
  const [catalogue, setCatalogue] = useState<Achievement[]>([])
  const [earned, setEarned]       = useState<UserAchievement[]>([])
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [{ data: cat }, { data: own }] = await Promise.all([
        supabase.from('achievements').select('*').order('sort_order'),
        supabase.from('user_achievements').select('*').eq('user_id', userId),
      ])
      if (cancelled) return
      setCatalogue((cat ?? []) as Achievement[])
      setEarned((own ?? []) as UserAchievement[])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [userId])

  // Realtime — re-pull our row whenever a new badge lands
  useEffect(() => {
    const ch = supabase
      .channel(`achievements:${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'user_achievements',
        filter: `user_id=eq.${userId}`,
      }, async () => {
        const { data } = await supabase.from('user_achievements').select('*').eq('user_id', userId)
        setEarned((data ?? []) as UserAchievement[])
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [userId])

  const earnedSet = new Set(earned.map(e => e.achievement_id))
  const total = catalogue.length
  const got   = earned.length
  const pct   = total > 0 ? Math.round((got / total) * 100) : 0

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider">Achievements</p>
        <span className="text-[10px] font-mono text-muted">{got} / {total} · {pct}%</span>
      </div>

      {loading ? (
        <div className="p-4 grid grid-cols-4 gap-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="aspect-square rounded-xl bg-surface-2 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="p-4 grid grid-cols-4 gap-2.5">
          {catalogue.map(a => {
            const isEarned = earnedSet.has(a.id)
            return (
              <div
                key={a.id}
                title={`${a.title} — ${a.description}`}
                className={`group relative aspect-square rounded-xl flex flex-col items-center justify-center gap-1 ring-1 transition-all ${
                  isEarned
                    ? `${TIER_RING[a.tier]} cursor-help`
                    : 'ring-border bg-surface-2/40 opacity-40 grayscale cursor-help'
                }`}
              >
                <span className="text-2xl leading-none">{a.icon}</span>
                <span className="text-[8px] font-semibold uppercase tracking-wider text-muted text-center leading-tight px-1">
                  {a.title}
                </span>
                {isEarned && (
                  <span className="absolute top-1 right-1 text-[7px] font-mono text-muted/60 uppercase">
                    {TIER_LABEL[a.tier][0]}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
