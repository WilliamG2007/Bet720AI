import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLeague } from '../contexts/LeagueContext'
import { useAuth } from '../contexts/AuthContext'
import type { User, LeagueMember, Prediction } from '../types/database'
import { Avatar } from '../components/Avatar'

interface Standing {
  member: LeagueMember
  user: User
  wins: number
  total: number
  winRate: number
  streak: number
  streakType: 'W' | 'L' | null
}

const MEDALS = ['🥇', '🥈', '🥉']

export default function LeaderboardPage() {
  const { authUser } = useAuth()
  const { activeLeague } = useLeague()
  const [standings, setStandings] = useState<Standing[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!activeLeague) return
    ;(async () => {
      setLoading(true)
      const { data: membersRaw } = await supabase.from('league_members').select('*')
        .eq('league_id', activeLeague.id).order('total_points', { ascending: false })
      const members = (membersRaw ?? []) as LeagueMember[]
      if (!members.length) { setStandings([]); setLoading(false); return }

      const userIds = members.map(m => m.user_id)
      const { data: usersRaw } = await supabase.from('users').select('*').in('id', userIds)
      const users = (usersRaw ?? []) as User[]
      const userMap = Object.fromEntries(users.map(u => [u.id, u]))

      const { data: predsRaw } = await supabase.from('predictions').select('*')
        .eq('league_id', activeLeague.id).eq('resolved', true).in('user_id', userIds)
      const preds = (predsRaw ?? []) as Prediction[]

      setStandings(members.map(m => {
        const up = preds.filter(p => p.user_id === m.user_id)
        const wins = up.filter(p => (p.points_won ?? 0) > 0).length
        const total = up.length
        const winRate = total > 0 ? Math.round((wins / total) * 100) : 0
        const recent = [...up].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5)
        let streak = 0; let streakType: 'W' | 'L' | null = null
        for (const p of recent) {
          const isWin = (p.points_won ?? 0) > 0
          if (streak === 0) { streakType = isWin ? 'W' : 'L'; streak = 1 }
          else if ((streakType === 'W') === isWin) streak++
          else break
        }
        return { member: m, user: userMap[m.user_id], wins, total, winRate, streak, streakType }
      }))
      setLoading(false)
    })()
  }, [activeLeague])

  if (!activeLeague) return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div>
        <div className="text-4xl mb-3">🏆</div>
        <p className="text-text font-semibold">No league selected</p>
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5">
        <div className="mb-5">
          <h1 className="text-base font-bold">Leaderboard</h1>
          <p className="text-xs text-muted mt-0.5">{activeLeague.name} · {activeLeague.season}</p>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <div key={i} className="card p-4 animate-pulse h-16 bg-surface-2" />)}
          </div>
        ) : standings.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">No members yet</div>
        ) : (
          <>
            {/* Top 3 podium */}
            {standings.length >= 2 && (
              <div className="flex items-end gap-2 mb-4 px-2">
                {[1, 0, 2].map(idx => {
                  const s = standings[idx]
                  if (!s) return <div key={idx} className="flex-1" />
                  const isMe = s.user?.id === authUser?.id
                  const heights = ['h-20', 'h-28', 'h-16']
                  const rank = idx + 1
                  return (
                    <div key={idx} className={`flex-1 flex flex-col items-center justify-end ${heights[idx]} rounded-xl border ${
                      rank === 1 ? 'border-accent/30 bg-accent/5' : 'border-border bg-surface'
                    } pb-3 px-2`}>
                      <span className="text-xl mb-1">{MEDALS[idx]}</span>
                      <Avatar url={s.user?.avatar_url} username={s.user?.username ?? '?'} size={28} />
                      <p className={`text-[10px] font-semibold mt-1.5 truncate w-full text-center ${isMe ? 'text-accent' : 'text-text'}`}>
                        {s.user?.username ?? '?'}
                      </p>
                      <p className={`font-mono font-bold text-sm mt-0.5 ${
                        s.member.total_points > 0 ? 'text-accent' : s.member.total_points < 0 ? 'text-danger' : 'text-muted'
                      }`}>
                        {s.member.total_points > 0 ? '+' : ''}{s.member.total_points}
                      </p>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Full list */}
            <div className="card divide-y divide-border">
              {standings.map((s, idx) => {
                const isMe = s.user?.id === authUser?.id
                return (
                  <div key={s.member.id} className={`flex items-center gap-3 px-4 py-3.5 ${isMe ? 'bg-accent/5' : ''}`}>
                    <div className="w-6 text-center flex-shrink-0">
                      {idx < 3
                        ? <span className="text-base">{MEDALS[idx]}</span>
                        : <span className="font-mono text-xs text-muted">{idx + 1}</span>
                      }
                    </div>
                    <Avatar url={s.user?.avatar_url} username={s.user?.username ?? '?'} size={32} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-semibold truncate ${isMe ? 'text-accent' : 'text-text'}`}>
                          {s.user?.username ?? 'Unknown'}
                        </span>
                        {isMe && <span className="text-[9px] text-muted font-semibold uppercase tracking-wider">you</span>}
                      </div>
                      <div className="flex items-center gap-2.5 mt-0.5">
                        <span className="text-[10px] font-mono text-muted/60">{s.wins}/{s.total}</span>
                        <span className="text-[10px] font-mono text-muted/60">{s.winRate}%</span>
                        {s.streak > 1 && s.streakType && (
                          <span className={`text-[10px] font-mono font-semibold ${s.streakType === 'W' ? 'text-accent' : 'text-danger'}`}>
                            {s.streakType}{s.streak}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className={`font-mono font-bold text-base flex-shrink-0 ${
                      s.member.total_points > 0 ? 'text-accent' : s.member.total_points < 0 ? 'text-danger' : 'text-muted'
                    }`}>
                      {s.member.total_points > 0 ? '+' : ''}{s.member.total_points}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
