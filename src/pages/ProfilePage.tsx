import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import type { Prediction, Match } from '../types/database'
import { RiskBadge } from '../components/RiskBadge'
import { Avatar } from '../components/Avatar'
import { TeamCrest } from '../components/TeamCrest'
import { format } from 'date-fns'

interface PredWithMatch { pred: Prediction; match: Match }
type StatsByType = Record<string, { wins: number; total: number }>

const TYPE_LABELS: Record<string, string> = { result: 'Match Result', exact_score: 'Exact Score', btts: 'BTTS' }

export default function ProfilePage() {
  const { authUser, profile, signOut } = useAuth()
  const [history, setHistory] = useState<PredWithMatch[]>([])
  const [stats, setStats] = useState<StatsByType>({ result: { wins: 0, total: 0 }, exact_score: { wins: 0, total: 0 }, btts: { wins: 0, total: 0 } })
  const [totalWon, setTotalWon] = useState(0)
  const [totalLost, setTotalLost] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authUser) return
    ;(async () => {
      setLoading(true)
      const { data: predsRaw } = await supabase.from('predictions').select('*')
        .eq('user_id', authUser.id).order('created_at', { ascending: false }).limit(50)
      const preds = (predsRaw ?? []) as Prediction[]
      if (!preds.length) { setLoading(false); return }

      const { data: matchesRaw } = await supabase.from('matches').select('*')
        .in('id', [...new Set(preds.map(p => p.match_id))])
      const matches = (matchesRaw ?? []) as Match[]
      const matchMap = Object.fromEntries(matches.map(m => [m.id, m]))

      const hist = preds.map(p => ({ pred: p, match: matchMap[p.match_id] })).filter(x => x.match) as PredWithMatch[]
      setHistory(hist)

      const statMap: StatsByType = { result: { wins: 0, total: 0 }, exact_score: { wins: 0, total: 0 }, btts: { wins: 0, total: 0 } }
      let won = 0, lost = 0
      for (const { pred: p } of hist.filter(x => x.pred.resolved)) {
        statMap[p.prediction_type] ??= { wins: 0, total: 0 }
        statMap[p.prediction_type].total++
        if ((p.points_won ?? 0) > 0) { statMap[p.prediction_type].wins++; won += p.points_won! }
        else lost += Math.abs(p.points_won ?? 0)
      }
      setStats(statMap); setTotalWon(won); setTotalLost(lost); setLoading(false)
    })()
  }, [authUser])

  const resolved = history.filter(x => x.pred.resolved)
  const wins = resolved.filter(x => (x.pred.points_won ?? 0) > 0).length
  const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : 0

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5">
        {/* Profile header */}
        <div className="card p-5 mb-4 flex items-center gap-4">
          <Avatar url={profile?.avatar_url} username={profile?.username ?? authUser?.email ?? '?'} size={52} />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-base">{profile?.username}</p>
            <p className="text-xs text-muted truncate mt-0.5">{authUser?.email}</p>
            {profile?.created_at && (
              <p className="text-[10px] text-muted/50 mt-1">Joined {format(new Date(profile.created_at), 'MMM yyyy')}</p>
            )}
          </div>
          <button onClick={signOut} className="btn-icon text-muted hover:text-danger">
            <LogOut size={15} />
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            { label: 'Predictions', value: history.length, color: '' },
            { label: 'Win Rate',    value: `${winRate}%`,  color: '' },
            { label: 'Won',         value: `+${totalWon}`, color: 'text-accent' },
            { label: 'Lost',        value: `-${totalLost}`,color: 'text-danger' },
          ].map(s => (
            <div key={s.label} className="card p-3 text-center">
              <p className={`font-mono font-bold text-sm ${s.color || 'text-text'}`}>{s.value}</p>
              <p className="text-[9px] text-muted uppercase tracking-wider mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Accuracy by type */}
        <div className="card mb-4 overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Accuracy by Type</p>
          </div>
          <div className="divide-y divide-border">
            {(Object.entries(stats) as [Prediction['prediction_type'], { wins: number; total: number }][]).map(([type, s]) => (
              <div key={type} className="px-4 py-3.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{TYPE_LABELS[type]}</span>
                  <span className="font-mono text-xs text-muted">{s.total > 0 ? `${Math.round((s.wins / s.total) * 100)}%` : '—'}</span>
                </div>
                <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-700"
                    style={{ width: s.total > 0 ? `${(s.wins / s.total) * 100}%` : '0%' }} />
                </div>
                <p className="text-[10px] text-muted/50 mt-1.5 font-mono">{s.wins} / {s.total} correct</p>
              </div>
            ))}
          </div>
        </div>

        {/* History */}
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60 mb-3">History</p>
        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <div key={i} className="card p-4 animate-pulse h-14 bg-surface-2" />)}
          </div>
        ) : history.length === 0 ? (
          <div className="text-center py-12 text-muted text-sm">No predictions yet</div>
        ) : (
          <div className="space-y-2">
            {history.map(({ pred: p, match: m }) => {
              const won  = p.resolved && (p.points_won ?? 0) > 0
              const lost = p.resolved && (p.points_won ?? 0) < 0
              return (
                <div key={p.id} className={`card p-3.5 flex items-center gap-3 ${won ? 'border-accent/20' : lost ? 'border-danger/20' : ''}`}>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <TeamCrest src={m.home_crest} name={m.home_team} size={16} />
                    <TeamCrest src={m.away_crest} name={m.away_team} size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-muted truncate">{m.home_team} vs {m.away_team}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="font-mono text-sm font-semibold">{p.predicted_value}</span>
                      <RiskBadge tier={p.risk_tier} />
                      {p.double_or_nothing && <span className="text-xs text-amber-400">⚡</span>}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {p.resolved ? (
                      <span className={`font-mono text-sm font-bold ${won ? 'text-accent' : 'text-danger'}`}>
                        {(p.points_won ?? 0) > 0 ? '+' : ''}{p.points_won}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-muted">{p.points_wagered} pt</span>
                    )}
                    <p className="text-[10px] text-muted/40 font-mono mt-0.5">{format(new Date(p.created_at), 'MMM d')}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
