import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, Layers } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { Bet, BetLeg, Match } from '../types/database'
import { Avatar } from '../components/Avatar'
import { TeamCrest } from '../components/TeamCrest'
import { AchievementsPanel } from '../components/AchievementsPanel'
import { format, isPast } from 'date-fns'

interface LegWithMatch { leg: BetLeg; match: Match }
interface BetWithLegs  { bet: Bet; legs: LegWithMatch[] }

type Tab    = 'active' | 'history' | 'profile'
type Filter = 'all' | 'singles' | 'parlays' | 'result' | 'btts' | 'exact_score'
type Sort   = 'date' | 'odds' | 'wager' | 'pnl'

const MARKET_LABELS: Record<string, string> = {
  '1x2':           'Result',
  btts:            'BTTS',
  exact_score:     'Exact',
  ou_goals:        'O/U',
  double_chance:   'DC',
  draw_no_bet:     'DNB',
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Upcoming', live: 'LIVE', finished: 'Finished', postponed: 'Postponed',
}

function selectionDisplay(leg: BetLeg, match: Match): string {
  const mt = leg.market_type
  const sel = leg.selection
  if (mt === '1x2') {
    if (sel === '1') return match.home_team
    if (sel === '2') return match.away_team
    return 'Draw'
  }
  if (mt === 'btts') return sel === 'yes' ? 'BTTS Yes' : 'BTTS No'
  if (mt === 'ou_goals') {
    const params = leg.params as { line?: number } | null
    const line = params?.line ?? '?'
    return `${sel === 'over' ? 'Over' : 'Under'} ${line}`
  }
  if (mt === 'double_chance') {
    if (sel === '1X') return `${match.home_team} or Draw`
    if (sel === 'X2') return `Draw or ${match.away_team}`
    if (sel === '12') return `${match.home_team} or ${match.away_team}`
  }
  if (mt === 'draw_no_bet') {
    return sel === '1' ? match.home_team : match.away_team
  }
  return sel
}

export default function BetsPage() {
  const { authUser, profile, signOut } = useAuth()
  const { activeLeague } = useLeague()

  const [tab, setTab]         = useState<Tab>('active')
  const [all, setAll]         = useState<BetWithLegs[]>([])
  const [loading, setLoading] = useState(true)

  const [filter, setFilter]   = useState<Filter>('all')
  const [sort, setSort]       = useState<Sort>('date')
  const [showWon, setShowWon] = useState(true)
  const [showLost, setShowLost] = useState(true)

  useEffect(() => {
    if (!authUser || !activeLeague) return
    ;(async () => {
      setLoading(true)
      // Fetch bets + nested legs in one round-trip.
      const { data: betsRaw } = await supabase
        .from('bets').select('*, bet_legs(*)')
        .eq('user_id', authUser.id)
        .eq('league_id', activeLeague.id)
        .order('created_at', { ascending: false })
      const betRows = (betsRaw ?? []) as Array<Bet & { bet_legs: BetLeg[] }>
      if (!betRows.length) { setAll([]); setLoading(false); return }

      const matchIds = [...new Set(betRows.flatMap(b => b.bet_legs.map(l => l.match_id)))]
      const { data: matchesRaw } = await supabase
        .from('matches').select('*').in('id', matchIds)
      const matches = (matchesRaw ?? []) as Match[]
      const matchMap = Object.fromEntries(matches.map(m => [m.id, m]))

      const out: BetWithLegs[] = betRows.map(b => ({
        bet: b,
        legs: b.bet_legs
          .map(l => ({ leg: l, match: matchMap[l.match_id] }))
          .filter(x => x.match),
      })).filter(x => x.legs.length > 0)
      setAll(out)
      setLoading(false)
    })()
  }, [authUser, activeLeague])

  const active  = all.filter(x => x.bet.status === 'pending')
  const history = all.filter(x => x.bet.status !== 'pending')

  function applyFiltersAndSort(list: BetWithLegs[]): BetWithLegs[] {
    let out = list

    if (filter === 'singles') out = out.filter(x => x.legs.length === 1)
    else if (filter === 'parlays') out = out.filter(x => x.legs.length > 1)
    else if (filter === 'result') out = out.filter(x => x.legs.some(l => l.leg.market_type === '1x2'))
    else if (filter === 'btts')   out = out.filter(x => x.legs.some(l => l.leg.market_type === 'btts'))
    else if (filter === 'exact_score') out = out.filter(x => x.legs.some(l => l.leg.market_type === 'exact_score'))

    if (tab === 'history') {
      if (!showWon)  out = out.filter(x => (x.bet.payout ?? 0) <= 0)
      if (!showLost) out = out.filter(x => (x.bet.payout ?? 0) >= 0)
    }

    return [...out].sort((a, b) => {
      switch (sort) {
        case 'odds':  return (b.bet.combined_multiplier ?? 1) - (a.bet.combined_multiplier ?? 1)
        case 'wager': return b.bet.stake - a.bet.stake
        case 'pnl':   return (b.bet.payout ?? 0) - (a.bet.payout ?? 0)
        default:      return b.bet.created_at.localeCompare(a.bet.created_at)
      }
    })
  }

  const activeFiltered  = applyFiltersAndSort(active)
  const historyFiltered = applyFiltersAndSort(history)

  const resolved = history
  const wins     = resolved.filter(x => (x.bet.payout ?? 0) > 0).length
  const winRate  = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : 0
  const totalWon  = resolved.filter(x => (x.bet.payout ?? 0) > 0).reduce((s, x) => s + (x.bet.payout ?? 0), 0)
  const totalLost = resolved.filter(x => (x.bet.payout ?? 0) < 0).reduce((s, x) => s + Math.abs(x.bet.payout ?? 0), 0)

  function BetCard({ bet, legs }: BetWithLegs) {
    const isParlay = legs.length > 1
    const won  = bet.status === 'won'
    const lost = bet.status === 'lost'
    const mult = bet.combined_multiplier ?? 1

    // For singles, the card links to the match. For parlays, link to the
    // first match (or just stay non-clickable for parlay — keep it simple).
    const firstMatch = legs[0].match
    const linkTo = `/match/${firstMatch.id}`

    return (
      <Link
        to={linkTo}
        className={`block card p-4 space-y-3 hover:border-white/15 transition-colors ${
          won ? 'border-accent/20' : lost ? 'border-danger/20' : ''
        }`}
      >
        {/* Header: parlay badge or match teams for single */}
        {isParlay ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Layers size={14} className="text-accent" />
              <span className="text-xs font-bold text-accent">{legs.length}-Leg Parlay</span>
            </div>
            <span className="text-[10px] font-mono text-muted/60">
              ×{(1 + mult).toFixed(2)} combined
            </span>
          </div>
        ) : (
          (() => {
            const m = firstMatch
            const isLive = m.status === 'live'
            return (
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
            )
          })()
        )}

        {/* Legs */}
        <div className={isParlay ? 'space-y-1.5 border-l-2 border-accent/20 pl-3' : ''}>
          {legs.map(({ leg, match }) => {
            const legWon  = leg.leg_status === 'won'
            const legLost = leg.leg_status === 'lost'
            const legVoid = leg.leg_status === 'void'
            return (
              <div key={leg.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {isParlay && (
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      legWon ? 'bg-accent' : legLost ? 'bg-danger' : legVoid ? 'bg-muted' : 'bg-muted/40'
                    }`} />
                  )}
                  <span className="text-[10px] text-muted/60 uppercase tracking-wider font-mono">
                    {MARKET_LABELS[leg.market_type] ?? leg.market_type}
                  </span>
                  <span className="font-mono font-bold text-xs text-text truncate">
                    {selectionDisplay(leg, match)}
                  </span>
                  {isParlay && (
                    <span className="text-[10px] text-muted/40 truncate">
                      · {match.home_team} v {match.away_team}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-mono text-muted/50 flex-shrink-0">
                  ×{leg.leg_decimal_odds.toFixed(2)}
                </span>
              </div>
            )
          })}
          {bet.double_or_nothing && (
            <div className="text-[10px] text-amber-400 mt-1">⚡ Double or Nothing</div>
          )}
        </div>

        {/* P&L row */}
        <div className="flex items-center justify-between pt-1 border-t border-border/60">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">Wagered</p>
              <p className="font-mono text-xs font-semibold text-text">{bet.stake} pt</p>
            </div>
            {bet.status === 'pending' && (
              <>
                <div>
                  <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">To win</p>
                  <p className="font-mono text-xs font-bold text-accent">
                    +{bet.potential_payout}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-muted/50 uppercase tracking-wider mb-0.5">At risk</p>
                  <p className="font-mono text-xs font-bold text-danger">
                    −{bet.double_or_nothing ? bet.stake * 2 : bet.stake}
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="text-right">
            {bet.status !== 'pending' ? (
              <span className={`font-mono font-bold text-base ${won ? 'text-accent' : lost ? 'text-danger' : 'text-muted'}`}>
                {(bet.payout ?? 0) > 0 ? '+' : ''}{bet.payout ?? 0}
              </span>
            ) : (
              <span className="text-[10px] font-mono text-muted/40">
                {format(new Date(firstMatch.kickoff_at), isPast(new Date(firstMatch.kickoff_at)) ? 'MMM d HH:mm' : 'EEE HH:mm')}
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

        {tab !== 'profile' && (
          <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
            {(['all', 'singles', 'parlays', 'result', 'btts', 'exact_score'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all ${
                  filter === f ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'
                }`}>
                {f === 'all' ? 'All'
                  : f === 'singles' ? 'Singles'
                  : f === 'parlays' ? 'Parlays'
                  : f === 'exact_score' ? 'Exact'
                  : f === 'result' ? 'Result' : 'BTTS'}
              </button>
            ))}

            <div className="w-px h-4 bg-border flex-shrink-0" />

            <select value={sort} onChange={e => setSort(e.target.value as Sort)}
              className="flex-shrink-0 bg-surface-2 border border-border rounded-xl text-[11px] font-semibold text-muted px-2.5 py-1.5 outline-none">
              <option value="date">Date</option>
              <option value="odds">Odds</option>
              <option value="wager">Wager</option>
              {tab === 'history' && <option value="pnl">P&amp;L</option>}
            </select>

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
                <div className="grid grid-cols-3 gap-2 mb-1">
                  {[
                    { label: 'Open', value: activeFiltered.length },
                    { label: 'Wagered', value: `${activeFiltered.reduce((s, x) => s + x.bet.stake, 0)} pt` },
                    { label: 'Potential', value: `+${activeFiltered.reduce((s, x) => s + x.bet.potential_payout, 0)}` },
                  ].map(s => (
                    <div key={s.label} className="card p-3 text-center">
                      <p className="font-mono font-bold text-sm text-text">{s.value}</p>
                      <p className="text-[9px] text-muted uppercase tracking-wider mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
                {activeFiltered.map(x => <BetCard key={x.bet.id} {...x} />)}
              </div>
            )}
          </>
        )}

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
                {historyFiltered.map(x => <BetCard key={x.bet.id} {...x} />)}
              </div>
            )}
          </>
        )}

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

            {authUser && <AchievementsPanel userId={authUser.id} />}

            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-semibold text-muted uppercase tracking-wider">Accuracy by Market</p>
              </div>
              <div className="divide-y divide-border">
                {(['1x2', 'btts', 'exact_score', 'ou_goals', 'double_chance', 'draw_no_bet'] as const).map(type => {
                  // Collect legs from resolved bets only (any leg can count).
                  const legBucket = resolved.flatMap(x => x.legs.filter(l => l.leg.market_type === type))
                  const w = legBucket.filter(l => l.leg.leg_status === 'won').length
                  const t = legBucket.filter(l => l.leg.leg_status === 'won' || l.leg.leg_status === 'lost').length
                  if (t === 0) return null
                  return (
                    <div key={type} className="px-4 py-3.5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">
                          {MARKET_LABELS[type] ?? type}
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
