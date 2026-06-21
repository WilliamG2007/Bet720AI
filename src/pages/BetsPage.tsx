import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { Prediction, Match } from '../types/database'
import { RiskBadge } from '../components/RiskBadge'
import { Avatar } from '../components/Avatar'
import { TeamCrest } from '../components/TeamCrest'
import { AchievementsPanel } from '../components/AchievementsPanel'
import { format, isPast } from 'date-fns'

interface PredWithMatch { pred: Prediction; match: Match }

type Tab = 'active' | 'history' | 'profile'
type Filter = 'all' | 'result' | 'btts' | 'exact_score'
type Sort  = 'date' | 'odds' | 'wager' | 'pnl'

const TYPE_LABELS: Record<string, string> = {
  result: 'Result', exact_score: 'Exact', btts: 'BTTS',
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Upcoming', live: 'LIVE', finished: 'Finished', postponed: 'Postponed',
}

export default function BetsPage() {
  const { authUser, profile, signOut } = useAuth()
  const { activeLeague } = useLeague()

  const [tab, setTab]         = useState<Tab>('active')
  const [all, setAll]         = useState<PredWithMatch[]>([])
  const [loading, setLoading] = useState(true)

  // filters / sort
  const [filter, setFilter]   = useState<Filter>('all')
  const [sort, setSort]       = useState<Sort>('date')
  const [showWon, setShowWon] = useState(true)
  const [showLost, setShowLost] = useState(true)

  useEffect(() => {
    if (!authUser || !activeLeague) return
    ;(async () => {
      setLoading(true)
      const { data: predsRaw } = await supabase
        .from('predictions').select('*')
        .eq('user_id', authUser.id)
        .eq('league_id', activeLeague.id)
        .order('created_at', { ascending: false })

      const preds = (predsRaw ?? []) as Prediction[]
      if (!preds.length) { setAll([]); setLoading(false); return }

      const matchIds = [...new Set(preds.map(p => p.match_id))]
      const { data: matchesRaw } = await supabase
        .from('matches').select('*').in('id', matchIds)
      const matches = (matchesRaw ?? []) as Match[]
      const matchMap = Object.fromEntries(matches.map(m => [m.id, m]))

      setAll(preds.map(p => ({ pred: p, match: matchMap[p.match_id] })).filter(x => x.match) as PredWithMatch[])
      setLoading(false)
    })()
  }, [authUser, activeLeague])

  // ── computed lists ──────────────────────────
  const active  = all.filter(x => !x.pred.resolved)
  const history = all.filter(x => x.pred.resolved)

  function applyFiltersAndSort(list: PredWithMatch[]): PredWithMatch[] {
    let out = list

    if (filter !== 'all') out = out.filter(x => x.pred.prediction_type === filter)

    if (tab === 'history') {
      if (!showWon)  out = out.filter(x => (x.pred.points_won ?? 0) <= 0)
      if (!showLost) out = out.filter(x => (x.pred.points_won ?? 0) >= 0)
    }

    return [...out].sort((a, b) => {
      switch (sort) {
        case 'odds':  return (b.pred.odds_multiplier ?? 1) - (a.pred.odds_multiplier ?? 1)
        case 'wager': return b.pred.points_wagered - a.pred.points_wagered
        case 'pnl':   return (b.pred.points_won ?? 0) - (a.pred.points_won ?? 0)
        default:      return b.pred.created_at.localeCompare(a.pred.created_at)
      }
    })
  }

  const activeFiltered  = applyFiltersAndSort(active)
  const historyFiltered = applyFiltersAndSort(history)

  // ── profile stats ───────────────────────────
  const resolved = history
  const wins     = resolved.filter(x => (x.pred.points_won ?? 0) > 0).length
  const winRate  = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : 0
  const totalWon  = resolved.filter(x => (x.pred.points_won ?? 0) > 0).reduce((s, x) => s + (x.pred.points_won ?? 0), 0)
  const totalLost = resolved.filter(x => (x.pred.points_won ?? 0) < 0).reduce((s, x) => s + Math.abs(x.pred.points_won ?? 0), 0)

  // ── helpers ─────────────────────────────────
  function PredCard({ pred: p, match: m }: PredWithMatch) {
    const won   = p.resolved && (p.points_won ?? 0) > 0
    const lost  = p.resolved && (p.points_won ?? 0) < 0
    const isLive = m.status === 'live'
    const mult  = p.odds_multiplier ?? 1

    return (
      <Link
        to={`/match/${m.id}`}
        className={`block card p-4 space-y-3 hover:border-white/15 transition-colors ${won ? 'border-accent/20' : lost ? 'border-danger/20' : isLive ? 'border-amber-500/30' : ''}`}
      >
        {/* Match row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <TeamCrest src={m.home_crest} name={m.home_team} size={16} />
            <span className="text-xs text-muted truncate">{m.home_team}</span>
            <span className="text-[10px] text-muted/40 font-mono">vs</span>
            <span className="text-xs text-muted truncate">{m.away_team}</span>
            <TeamCrest src={m.away_crest} name={m.away_team} size={16} />
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isLive && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${
              isLive ? 'text-amber-400' : 'text-muted/50'
            }`}>{STATUS_LABEL[m.status]}</span>
            {m.status === 'finished' && m.home_score != null && (
              <span className="text-[10px] font-mono text-muted/60">
                {m.home_score}–{m.away_score}
              </span>
            )}
          </div>
        </div>

        {/* Prediction row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RiskBadge tier={p.risk_tier} />
            <span className="text-[10px] text-muted/60 uppercase tracking-wider">{TYPE_LABELS[p.prediction_type]}</span>
            <span className="font-mono font-bold text-sm text-text">{p.predicted_value}</span>
            {p.double_or_nothing && <span className="text-xs text-amber-400">⚡</span>}
          </div>
          <div className="text-right">
            <span className="text-[10px] font-mono text-muted/50">×{mult.toFixed(2)}</span>
          </div>
        </div>

        {/* P&L row */}
        <div className="flex items-center justify-between pt-1 border-t border-border/60">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">Wagered</p>
              <p className="font-mono text-xs font-semibold text-text">{p.points_wagered} pt</p>
            </div>
            {!p.resolved && (
              <>
                <div>
                  <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">To win</p>
                  <p className="font-mono text-xs font-bold text-accent">
                    +{Math.round(p.points_wagered * (p.double_or_nothing ? mult * 2 : mult))}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">At risk</p>
                  <p className="font-mono text-xs font-bold text-danger">
                    −{p.double_or_nothing ? p.points_wagered * 2 : p.points_wagered}
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="text-right">
            {p.resolved ? (
              <span className={`font-mono font-bold text-base ${won ? 'text-accent' : 'text-danger'}`}>
                {(p.points_won ?? 0) > 0 ? '+' : ''}{p.points_won}
              </span>
            ) : (
              <span className="text-[10px] font-mono text-muted/40">
                {format(new Date(m.kickoff_at), isPast(new Date(m.kickoff_at)) ? 'MMM d HH:mm' : 'EEE HH:mm')}
              </span>
            )}
          </div>
        </div>
      </Link>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5">

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-surface-2 rounded-xl p-1">
          {(['active', 'history', 'profile'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all duration-150 ${
                tab === t ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'
              }`}>
              {t === 'active' ? `Active ${active.length > 0 ? `(${active.length})` : ''}` : t === 'history' ? 'History' : 'Profile'}
            </button>
          ))}
        </div>

        {/* Filter + sort bar (active & history) */}
        {tab !== 'profile' && (
          <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
            {/* Type filter */}
            {(['all', 'result', 'btts', 'exact_score'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all ${
                  filter === f ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'
                }`}>
                {f === 'all' ? 'All' : f === 'exact_score' ? 'Exact' : TYPE_LABELS[f]}
              </button>
            ))}

            <div className="w-px h-4 bg-border flex-shrink-0" />

            {/* Sort */}
            <select value={sort} onChange={e => setSort(e.target.value as Sort)}
              className="flex-shrink-0 bg-surface-2 border border-border rounded-xl text-[11px] font-semibold text-muted px-2.5 py-1.5 outline-none">
              <option value="date">Date</option>
              <option value="odds">Odds</option>
              <option value="wager">Wager</option>
              {tab === 'history' && <option value="pnl">P&amp;L</option>}
            </select>

            {/* Win/loss toggles for history */}
            {tab === 'history' && (
              <>
                <button onClick={() => setShowWon(!showWon)}
                  className={`flex-shrink-0 px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border transition-all ${
                    showWon ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-muted'
                  }`}>W</button>
                <button onClick={() => setShowLost(!showLost)}
                  className={`flex-shrink-0 px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border transition-all ${
                    showLost ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border text-muted'
                  }`}>L</button>
              </>
            )}
          </div>
        )}

        {/* ── ACTIVE BETS ── */}
        {tab === 'active' && (
          <>
            {loading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <div key={i} className="card p-4 animate-pulse h-28 bg-surface-2" />)}
              </div>
            ) : activeFiltered.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-4xl mb-3">🎯</div>
                <p className="text-text font-semibold">No active bets</p>
                <p className="text-muted text-sm mt-1">Head to Predict to place some.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Summary strip */}
                <div className="grid grid-cols-3 gap-2 mb-1">
                  {[
                    { label: 'Open', value: activeFiltered.length },
                    { label: 'Wagered', value: `${activeFiltered.reduce((s, x) => s + x.pred.points_wagered, 0)} pt` },
                    { label: 'Potential', value: `+${activeFiltered.reduce((s, x) => {
                      const m = x.pred.odds_multiplier ?? 1
                      return s + Math.round(x.pred.points_wagered * (x.pred.double_or_nothing ? m * 2 : m))
                    }, 0)}` },
                  ].map(s => (
                    <div key={s.label} className="card p-3 text-center">
                      <p className="font-mono font-bold text-sm text-text">{s.value}</p>
                      <p className="text-[9px] text-muted uppercase tracking-wider mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
                {activeFiltered.map(x => <PredCard key={x.pred.id} {...x} />)}
              </div>
            )}
          </>
        )}

        {/* ── HISTORY ── */}
        {tab === 'history' && (
          <>
            {loading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => <div key={i} className="card p-4 animate-pulse h-28 bg-surface-2" />)}
              </div>
            ) : historyFiltered.length === 0 ? (
              <div className="text-center py-16 text-muted text-sm">No results match your filters.</div>
            ) : (
              <div className="space-y-3">
                {/* Summary strip */}
                <div className="grid grid-cols-4 gap-2 mb-1">
                  {[
                    { label: 'Bets',     value: historyFiltered.length,    color: '' },
                    { label: 'Win %',    value: `${winRate}%`,             color: '' },
                    { label: 'Won',      value: `+${totalWon}`,            color: 'text-accent' },
                    { label: 'Lost',     value: `-${totalLost}`,           color: 'text-danger' },
                  ].map(s => (
                    <div key={s.label} className="card p-3 text-center">
                      <p className={`font-mono font-bold text-sm ${s.color || 'text-text'}`}>{s.value}</p>
                      <p className="text-[9px] text-muted uppercase tracking-wider mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
                {historyFiltered.map(x => <PredCard key={x.pred.id} {...x} />)}
              </div>
            )}
          </>
        )}

        {/* ── PROFILE ── */}
        {tab === 'profile' && (
          <div className="space-y-4">
            <div className="card p-5 flex items-center gap-4">
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

            {/* Stats */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Bets',     value: all.length,       color: '' },
                { label: 'Win Rate', value: `${winRate}%`,    color: '' },
                { label: 'Won',      value: `+${totalWon}`,   color: 'text-accent' },
                { label: 'Lost',     value: `-${totalLost}`,  color: 'text-danger' },
              ].map(s => (
                <div key={s.label} className="card p-3 text-center">
                  <p className={`font-mono font-bold text-sm ${s.color || 'text-text'}`}>{s.value}</p>
                  <p className="text-[9px] text-muted uppercase tracking-wider mt-1">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Achievements */}
            {authUser && <AchievementsPanel userId={authUser.id} />}

            {/* Accuracy by type */}
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-semibold text-muted uppercase tracking-wider">Accuracy by Type</p>
              </div>
              <div className="divide-y divide-border">
                {(['result', 'btts', 'exact_score'] as const).map(type => {
                  const bucket = history.filter(x => x.pred.prediction_type === type)
                  const w = bucket.filter(x => (x.pred.points_won ?? 0) > 0).length
                  const t = bucket.length
                  return (
                    <div key={type} className="px-4 py-3.5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">
                          {type === 'result' ? 'Match Result' : type === 'btts' ? 'BTTS' : 'Exact Score'}
                        </span>
                        <span className="font-mono text-xs text-muted">{t > 0 ? `${Math.round((w / t) * 100)}%` : '—'}</span>
                      </div>
                      <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                        <div className="h-full bg-accent rounded-full transition-all duration-700"
                          style={{ width: t > 0 ? `${(w / t) * 100}%` : '0%' }} />
                      </div>
                      <p className="text-[10px] text-muted/50 mt-1.5 font-mono">{w} / {t} correct</p>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
