import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Lock } from 'lucide-react'
import { format } from 'date-fns'
import { supabase } from '../lib/supabase'
import { useLeague } from '../contexts/LeagueContext'
import { useAuth } from '../contexts/AuthContext'
import { TeamCrest } from '../components/TeamCrest'
import { Avatar } from '../components/Avatar'
import { RiskBadge } from '../components/RiskBadge'
import type { Match, Prediction, User } from '../types/database'

interface PredWithUser {
  pred: Prediction
  user: User
}

const TYPE_LABELS: Record<string, string> = {
  result: 'Result', exact_score: 'Exact', btts: 'BTTS',
}

/**
 * Per-match deep-dive. Shows the live match state, odds breakdown,
 * pick distribution among the active league, and the full bet list
 * scoped to the current league.
 *
 * Reachable from feed items, bet history cards, and match cards.
 */
export default function MatchDetailPage() {
  const { matchId = '' } = useParams<{ matchId: string }>()
  const navigate = useNavigate()
  const { activeLeague } = useLeague()
  const { authUser } = useAuth()

  const [match,    setMatch]    = useState<Match | null>(null)
  const [bets,     setBets]     = useState<PredWithUser[]>([])
  const [loading,  setLoading]  = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { data: m } = await supabase.from('matches').select('*').eq('id', matchId).maybeSingle()
      if (cancelled) return
      if (!m) { setNotFound(true); setLoading(false); return }
      setMatch(m as Match)

      if (!activeLeague) { setBets([]); setLoading(false); return }

      const { data: predsRaw } = await supabase
        .from('predictions').select('*')
        .eq('match_id', matchId)
        .eq('league_id', activeLeague.id)
        .order('created_at', { ascending: false })
      const preds = (predsRaw ?? []) as Prediction[]

      if (preds.length === 0) { setBets([]); setLoading(false); return }
      const userIds = [...new Set(preds.map(p => p.user_id))]
      const { data: usersRaw } = await supabase.from('users').select('*').in('id', userIds)
      const users = (usersRaw ?? []) as User[]
      const userMap = Object.fromEntries(users.map(u => [u.id, u]))

      if (cancelled) return
      setBets(preds.map(p => ({ pred: p, user: userMap[p.user_id] })).filter(b => b.user))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [matchId, activeLeague])

  // Poll match data every 30 s while live — skips waiting for cron
  useEffect(() => {
    if (!match || match.status !== 'live') return
    const interval = setInterval(async () => {
      const { data } = await supabase.from('matches').select('*').eq('id', matchId).maybeSingle()
      if (data) setMatch(data as Match)
    }, 30_000)
    return () => clearInterval(interval)
  }, [matchId, match?.status])

  const distribution = useMemo(() => {
    const buckets = { home: 0, draw: 0, away: 0, btts_y: 0, btts_n: 0 }
    for (const { pred } of bets) {
      if (pred.prediction_type === 'result') {
        if (pred.predicted_value === 'home') buckets.home++
        else if (pred.predicted_value === 'draw') buckets.draw++
        else if (pred.predicted_value === 'away') buckets.away++
      } else if (pred.prediction_type === 'btts') {
        if (pred.predicted_value === 'yes') buckets.btts_y++
        else if (pred.predicted_value === 'no') buckets.btts_n++
      }
    }
    return buckets
  }, [bets])

  const resultTotal = distribution.home + distribution.draw + distribution.away
  const bttsTotal   = distribution.btts_y + distribution.btts_n

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-5 space-y-4">
          <div className="h-9 w-32 bg-surface-2 rounded-xl animate-pulse" />
          <div className="card h-32 animate-pulse bg-surface-2" />
          <div className="card h-24 animate-pulse bg-surface-2" />
          <div className="card h-48 animate-pulse bg-surface-2" />
        </div>
      </div>
    )
  }

  if (notFound || !match) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-12 text-center">
          <div className="text-4xl mb-3">🤷</div>
          <p className="font-semibold text-text">Match not found</p>
          <button onClick={() => navigate(-1)} className="mt-4 text-sm text-accent">Go back</button>
        </div>
      </div>
    )
  }

  const kickoff    = new Date(match.kickoff_at)
  const isLive     = match.status === 'live'
  const isFinished = match.status === 'finished'
  const isScheduled = match.status === 'scheduled'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5 space-y-4">

        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-text"
        >
          <ArrowLeft size={14} /> Back
        </button>

        {/* Match header */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-semibold text-muted/60 uppercase tracking-wider">{match.competition}</span>
            <div className="flex items-center gap-1.5">
              {isLive && <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />}
              <span className={`text-[10px] font-mono font-semibold ${isLive ? 'text-danger' : isFinished ? 'text-muted/60' : 'text-accent/80'}`}>
                {isLive ? 'LIVE' : isFinished ? 'FULL TIME' : format(kickoff, 'EEE, MMM d · HH:mm')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1 flex flex-col items-center gap-2">
              <TeamCrest src={match.home_crest} name={match.home_team} size={48} />
              <span className="text-sm font-semibold text-text text-center">{match.home_team}</span>
            </div>
            <div className="flex-shrink-0 text-center">
              {(isFinished || isLive) ? (
                <div className={`font-mono font-bold text-3xl ${isLive ? 'text-danger' : 'text-text'}`}>
                  {match.home_score ?? 0}
                  <span className="text-muted/30 mx-2">–</span>
                  {match.away_score ?? 0}
                </div>
              ) : (
                <div className="text-muted/50 text-2xl font-mono">vs</div>
              )}
            </div>
            <div className="flex-1 flex flex-col items-center gap-2">
              <TeamCrest src={match.away_crest} name={match.away_team} size={48} />
              <span className="text-sm font-semibold text-text text-center">{match.away_team}</span>
            </div>
          </div>

          {match.stage && (
            <div className="mt-4 pt-3 border-t border-border text-center">
              <span className="text-[10px] font-mono text-muted uppercase tracking-wider">
                {match.stage.replace(/_/g, ' ')}
                {match.group ? ` · ${match.group.replace('GROUP_', 'Group ')}` : ''}
              </span>
            </div>
          )}
        </div>

        {/* Odds */}
        {(match.home_odds || match.draw_odds || match.away_odds) && (
          <div className="card p-4">
            <p className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-3">Match Odds</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: '1', value: match.home_odds },
                { label: 'X', value: match.draw_odds },
                { label: '2', value: match.away_odds },
              ].map(o => (
                <div key={o.label} className="bg-surface-2 rounded-xl py-3 text-center">
                  <p className="text-[10px] font-mono text-muted">{o.label}</p>
                  <p className="font-mono font-bold text-base text-text mt-1">
                    {o.value ? `×${o.value.toFixed(2)}` : '—'}
                  </p>
                </div>
              ))}
            </div>
            {(match.btts_yes_odds || match.btts_no_odds) && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="bg-surface-2 rounded-xl py-3 text-center">
                  <p className="text-[10px] font-mono text-muted">BTTS Yes</p>
                  <p className="font-mono font-bold text-sm text-text mt-1">
                    {match.btts_yes_odds ? `×${match.btts_yes_odds.toFixed(2)}` : '—'}
                  </p>
                </div>
                <div className="bg-surface-2 rounded-xl py-3 text-center">
                  <p className="text-[10px] font-mono text-muted">BTTS No</p>
                  <p className="font-mono font-bold text-sm text-text mt-1">
                    {match.btts_no_odds ? `×${match.btts_no_odds.toFixed(2)}` : '—'}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pick distribution */}
        {bets.length > 0 && (
          <div className="card p-4 space-y-3">
            <p className="text-[10px] font-semibold text-muted uppercase tracking-wider">League Picks · {activeLeague?.name ?? 'No league'}</p>
            {resultTotal > 0 && (
              <DistroBar
                items={[
                  { label: match.home_team, count: distribution.home, total: resultTotal, color: 'bg-accent' },
                  { label: 'Draw',          count: distribution.draw, total: resultTotal, color: 'bg-muted' },
                  { label: match.away_team, count: distribution.away, total: resultTotal, color: 'bg-amber-400' },
                ]}
              />
            )}
            {bttsTotal > 0 && (
              <DistroBar
                items={[
                  { label: 'BTTS Yes', count: distribution.btts_y, total: bttsTotal, color: 'bg-accent' },
                  { label: 'BTTS No',  count: distribution.btts_n, total: bttsTotal, color: 'bg-danger' },
                ]}
              />
            )}
          </div>
        )}

        {/* Bet list */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">All Bets</p>
            <span className="text-[10px] font-mono text-muted">{bets.length}</span>
          </div>
          {bets.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Lock size={20} className="mx-auto text-muted/40" />
              <p className="text-sm text-muted mt-3">No-one in this league has bet on it yet</p>
              {isScheduled && (
                <Link to="/predict" className="inline-block mt-3 text-xs text-accent font-semibold">Be the first →</Link>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {bets.map(({ pred, user }) => {
                const won  = pred.resolved && (pred.points_won ?? 0) > 0
                const lost = pred.resolved && (pred.points_won ?? 0) < 0
                const mine = authUser?.id === user.id
                return (
                  <li key={pred.id} className={`px-4 py-3 flex items-center gap-3 ${mine ? 'bg-accent/[0.04]' : ''}`}>
                    <Avatar url={user.avatar_url} username={user.username} size={32} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-text truncate">
                          {user.username}{mine && <span className="text-[10px] text-accent ml-1">(you)</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <RiskBadge tier={pred.risk_tier} />
                        <span className="text-[10px] text-muted/60 uppercase tracking-wider">{TYPE_LABELS[pred.prediction_type]}</span>
                        <span className="font-mono font-bold text-xs text-text">{pred.predicted_value}</span>
                        {pred.double_or_nothing && <span className="text-xs text-amber-400">⚡</span>}
                      </div>
                      {pred.reasoning && (
                        <p className="text-[11px] text-muted mt-1 italic line-clamp-1">"{pred.reasoning}"</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="font-mono font-bold text-sm text-text">{pred.points_wagered}p</p>
                      {pred.resolved ? (
                        <p className={`font-mono text-xs font-bold ${won ? 'text-accent' : lost ? 'text-danger' : 'text-muted'}`}>
                          {(pred.points_won ?? 0) > 0 ? '+' : ''}{pred.points_won}
                        </p>
                      ) : (
                        <p className="text-[10px] font-mono text-muted">×{(pred.odds_multiplier ?? 1).toFixed(2)}</p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

interface DistroItem { label: string; count: number; total: number; color: string }

function DistroBar({ items }: { items: DistroItem[] }) {
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden bg-surface-2">
        {items.map(i => (
          <div
            key={i.label}
            className={i.color}
            style={{ width: `${(i.count / i.total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-muted">
        {items.map(i => (
          <span key={i.label} className="truncate">
            <span className="font-semibold text-text">{Math.round((i.count / i.total) * 100)}%</span>{' '}{i.label} ({i.count})
          </span>
        ))}
      </div>
    </div>
  )
}
