import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { Match, Prediction } from '../types/database'
import { MatchCard } from '../components/MatchCard'
import { PredictionModal } from '../components/PredictionModal'
import { RiskBadge } from '../components/RiskBadge'
import { syncUpcomingMatches } from '../lib/matchSync'

export default function PredictPage() {
  const { authUser } = useAuth()
  const { activeLeague } = useLeague()
  const [matches, setMatches] = useState<Match[]>([])
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [selected, setSelected] = useState<Match | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  async function loadMatches() {
    setLoading(true)
    const { data } = await supabase.from('matches').select('*')
      .in('status', ['scheduled', 'live'])
      .order('kickoff_at', { ascending: true }).limit(30)
    setMatches((data ?? []) as Match[])
    setLoading(false)
  }

  async function loadPredictions() {
    if (!authUser || !activeLeague) return
    const { data } = await supabase.from('predictions').select('*')
      .eq('user_id', authUser.id).eq('league_id', activeLeague.id)
    setPredictions((data ?? []) as Prediction[])
  }

  async function handleSync() {
    setSyncing(true)
    await syncUpcomingMatches()
    await loadMatches()
    setSyncing(false)
  }

  useEffect(() => { loadMatches(); loadPredictions() }, [authUser, activeLeague])

  const matchDays = matches.reduce<Record<string, Match[]>>((acc, m) => {
    const day = m.matchday
      ? `Matchday ${m.matchday}`
      : new Date(m.kickoff_at).toLocaleDateString('en-GB', { weekday: 'long', month: 'short', day: 'numeric' })
    ;(acc[day] ??= []).push(m)
    return acc
  }, {})

  const pointsUsed = predictions.reduce((s, p) => s + p.points_wagered, 0)
  const hasUsedDouble = predictions.some(p => p.double_or_nothing)

  if (!activeLeague) return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div>
        <div className="text-4xl mb-3">🏟</div>
        <p className="text-text font-semibold">No league selected</p>
        <p className="text-muted text-sm mt-1">Join or create a league first.</p>
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-base font-bold">Predict</h1>
          <button onClick={handleSync} disabled={syncing} className="btn-icon">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Budget bar */}
        <div className="card p-4 mb-5">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Matchday Budget</span>
            <span className="font-mono text-xs">
              <span className={pointsUsed > 100 ? 'text-danger font-bold' : 'text-text'}>{pointsUsed}</span>
              <span className="text-muted/50"> / 100 pts</span>
            </span>
          </div>
          <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${pointsUsed > 100 ? 'bg-danger' : 'bg-accent'}`}
              style={{ width: `${Math.min(100, pointsUsed)}%` }} />
          </div>
          {hasUsedDouble && (
            <p className="text-[11px] text-amber-400 mt-2 flex items-center gap-1">
              <span>⚡</span> Double-or-Nothing used
            </p>
          )}
        </div>

        {loading ? (
          <div className="space-y-2.5">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="card p-4 animate-pulse h-24 bg-surface-2" />
            ))}
          </div>
        ) : matches.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-text font-semibold">No upcoming matches</p>
            <p className="text-muted text-sm mt-1">Sync to pull the latest fixtures.</p>
            <button onClick={handleSync} className="btn-ghost mt-4">Sync now</button>
          </div>
        ) : (
          Object.entries(matchDays).map(([day, dayMatches]) => (
            <div key={day} className="mb-6">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60 mb-3">{day}</p>
              <div className="space-y-2">
                {dayMatches.map(match => {
                  const preds = predictions.filter(p => p.match_id === match.id)
                  return (
                    <div key={match.id}>
                      <MatchCard match={match} onClick={() => setSelected(match)} selected={selected?.id === match.id} />
                      {preds.length > 0 && (
                        <div className="mt-1.5 ml-1 flex flex-wrap gap-1.5">
                          {preds.map(p => (
                            <div key={p.id} className="flex items-center gap-1.5 bg-surface-2 border border-border rounded-lg px-2.5 py-1.5">
                              <RiskBadge tier={p.risk_tier} />
                              <span className="text-xs font-mono font-semibold text-text">{p.predicted_value}</span>
                              <span className="text-[10px] font-mono text-muted">{p.points_wagered}pt</span>
                              {p.double_or_nothing && <span className="text-xs text-amber-400">⚡</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {selected && (
        <PredictionModal
          match={selected} leagueId={activeLeague.id}
          existingPredictions={predictions.filter(p => p.match_id === selected.id)}
          hasUsedDoubleOrNothing={hasUsedDouble}
          onClose={() => setSelected(null)}
          onSuccess={() => { setSelected(null); loadPredictions() }}
        />
      )}
    </div>
  )
}
