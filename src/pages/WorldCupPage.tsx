import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { Match, Prediction } from '../types/database'
import { PredictionModal } from '../components/PredictionModal'
import { TeamCrest } from '../components/TeamCrest'
import { RiskBadge } from '../components/RiskBadge'
import { fetchUpcomingMatches, fetchLiveCompetitionMatches, fdMatchToDbMatch, COMPETITIONS } from '../lib/footballApi'
import { estimateLiveMinute, computeLiveOdds, DEFAULT_MATCH_ODDS } from '../lib/poissonOdds'
import { format, isPast, isToday, isTomorrow } from 'date-fns'

const GROUP_ORDER = [
  'GROUP_A','GROUP_B','GROUP_C','GROUP_D',
  'GROUP_E','GROUP_F','GROUP_G','GROUP_H',
  'GROUP_I','GROUP_J','GROUP_K','GROUP_L',
]

const STAGE_LABELS: Record<string, string> = {
  GROUP_STAGE:     'Group Stage',
  LAST_16:         'Round of 16',
  QUARTER_FINALS:  'Quarter-Finals',
  SEMI_FINALS:     'Semi-Finals',
  THIRD_PLACE:     '3rd Place',
  FINAL:           'Final',
}

function groupLabel(g: string): string {
  return g.replace('GROUP_', 'Group ')
}

function kickoffLabel(d: string): string {
  const dt = new Date(d)
  if (isToday(dt))    return `Today · ${format(dt, 'HH:mm')}`
  if (isTomorrow(dt)) return `Tomorrow · ${format(dt, 'HH:mm')}`
  return format(dt, 'EEE d MMM · HH:mm')
}

export default function WorldCupPage() {
  const { authUser } = useAuth()
  const { activeLeague } = useLeague()

  const [matches, setMatches]         = useState<Match[]>([])
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [selected, setSelected]       = useState<Match | null>(null)
  const [loading, setLoading]         = useState(true)
  const [syncing, setSyncing]         = useState(false)
  const [tab, setTab]                 = useState<'upcoming' | 'live' | 'results'>('upcoming')

  async function loadMatches() {
    setLoading(true)
    const { data } = await supabase
      .from('matches').select('*')
      .eq('competition', 'FIFA World Cup')
      .in('status', tab === 'results' ? ['finished'] : tab === 'live' ? ['live'] : ['scheduled', 'live'])
      .order('kickoff_at', { ascending: tab !== 'results' })
      .limit(100)
    setMatches((data ?? []) as Match[])
    setLoading(false)
  }

  async function loadPredictions() {
    if (!authUser || !activeLeague) return
    const { data } = await supabase
      .from('predictions').select('*')
      .eq('user_id', authUser.id)
      .eq('league_id', activeLeague.id)
    setPredictions((data ?? []) as Prediction[])
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const today   = format(new Date(), 'yyyy-MM-dd')
      const end     = '2026-07-19'
      const raw     = await fetchUpcomingMatches(COMPETITIONS.WC.id, today, end)
      const rows    = raw.map(fdMatchToDbMatch) as Record<string, unknown>[]
      await supabase.from('matches').upsert(rows, { onConflict: 'external_id' })
    } catch (e) {
      console.error('WC sync error:', e)
    }
    await loadMatches()
    setSyncing(false)
  }

  /** Pull live + just-finished matches, update scores/status, resolve finished. */
  async function syncLive() {
    try {
      const raw = await fetchLiveCompetitionMatches(COMPETITIONS.WC.id)
      if (!raw.length) return
      const rows = raw.map(fdMatchToDbMatch) as Record<string, unknown>[]
      await supabase.from('matches').upsert(rows, { onConflict: 'external_id' })

      // Resolve any that just finished
      const finished = raw.filter(m => m.status === 'FINISHED')
      if (finished.length) {
        const { data } = await supabase.from('matches').select('id, external_id')
          .in('external_id', finished.map(m => m.id))
        for (const row of (data ?? []) as { id: string }[]) {
          await supabase.rpc('resolve_predictions', { p_match_id: row.id })
        }
      }
      await loadMatches()
    } catch (e) {
      console.error('WC live sync error:', e)
    }
  }

  useEffect(() => {
    ;(async () => {
      const { count } = await supabase
        .from('matches').select('id', { count: 'exact', head: true })
        .eq('competition', 'FIFA World Cup')
      if (!count) await handleSync()
      else await loadMatches()
      await loadPredictions()
      await syncLive()   // catch any in-play games on entry
    })()
  }, [authUser, activeLeague, tab])

  // Poll live matches every 30s while on the WC page
  useEffect(() => {
    const iv = setInterval(syncLive, 30_000)
    return () => clearInterval(iv)
  }, [])

  // Group upcoming by group/stage
  const liveMatches = matches.filter(m => m.status === 'live')
  const upcomingGrouped = matches
    .filter(m => !isPast(new Date(m.kickoff_at)) || m.status === 'scheduled')
    .reduce<Record<string, Match[]>>((acc, m) => {
      const key = m.group ? groupLabel(m.group) : (STAGE_LABELS[m.stage ?? ''] ?? m.stage ?? 'Other')
      ;(acc[key] ??= []).push(m)
      return acc
    }, {})

  // Sort groups by canonical order
  const sortedGroups = Object.keys(upcomingGrouped).sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(`GROUP_${a.replace('Group ', '')}`)
    const bi = GROUP_ORDER.indexOf(`GROUP_${b.replace('Group ', '')}`)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  const hasUsedDouble = predictions.some(p => p.double_or_nothing)

  /**
   * Populate a match's odds fields. Live matches get fresh in-play odds from
   * the live Poisson model (current score + estimated minute); scheduled
   * matches use stored/default pre-match odds.
   */
  function withComputedOdds(m: Match): Match {
    const homeExp = m.expected_home_goals ?? DEFAULT_MATCH_ODDS.homeExpected
    const awayExp = m.expected_away_goals ?? DEFAULT_MATCH_ODDS.awayExpected

    if (m.status === 'live') {
      const minute = estimateLiveMinute(m.kickoff_at)
      const o = computeLiveOdds(homeExp, awayExp, m.home_score ?? 0, m.away_score ?? 0, minute)
      return {
        ...m,
        home_odds: o.home, draw_odds: o.draw, away_odds: o.away,
        btts_yes_odds: o.bttsYes, btts_no_odds: o.bttsNo,
        expected_home_goals: o.homeExpected, expected_away_goals: o.awayExpected,
      }
    }
    return {
      ...m,
      home_odds:     m.home_odds     ?? DEFAULT_MATCH_ODDS.home,
      draw_odds:     m.draw_odds     ?? DEFAULT_MATCH_ODDS.draw,
      away_odds:     m.away_odds     ?? DEFAULT_MATCH_ODDS.away,
      btts_yes_odds: m.btts_yes_odds ?? DEFAULT_MATCH_ODDS.bttsYes,
      btts_no_odds:  m.btts_no_odds  ?? DEFAULT_MATCH_ODDS.bttsNo,
      expected_home_goals: homeExp,
      expected_away_goals: awayExp,
    }
  }

  function MatchRow({ m: rawM }: { m: Match }) {
    const m          = withComputedOdds(rawM)
    const preds      = predictions.filter(p => p.match_id === m.id)
    const isLive     = m.status === 'live'
    const isFinished = m.status === 'finished'
    // Live matches ARE bettable (in-play). Only finished/postponed lock.
    const locked     = m.status === 'finished' || m.status === 'postponed'
    const minute     = isLive ? estimateLiveMinute(m.kickoff_at) : 0

    return (
      <div>
        <button
          onClick={() => !locked && activeLeague && setSelected(m)}
          disabled={locked || !activeLeague}
          className={`w-full text-left px-4 py-3.5 transition-colors hover:bg-surface-2/50 ${
            isLive ? 'bg-amber-500/5' : ''
          } disabled:cursor-default`}
        >
          <div className="flex items-center justify-between gap-3">
            {/* Teams */}
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <TeamCrest src={m.home_crest} name={m.home_team} size={20} />
                <span className={`text-sm font-semibold ${isFinished && (m.home_score ?? 0) > (m.away_score ?? 0) ? 'text-text' : 'text-muted'}`}>
                  {m.home_team}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TeamCrest src={m.away_crest} name={m.away_team} size={20} />
                <span className={`text-sm font-semibold ${isFinished && (m.away_score ?? 0) > (m.home_score ?? 0) ? 'text-text' : 'text-muted'}`}>
                  {m.away_team}
                </span>
              </div>
            </div>

            {/* Score (live/finished) */}
            {(isFinished || isLive) && (
              <div className="space-y-1.5 flex-shrink-0">
                <div className={`font-mono font-bold text-xl leading-none ${isLive ? 'text-amber-400' : 'text-text'}`}>
                  {m.home_score ?? 0}
                </div>
                <div className={`font-mono font-bold text-xl leading-none ${isLive ? 'text-amber-400' : 'text-text'}`}>
                  {m.away_score ?? 0}
                </div>
              </div>
            )}

            {/* Odds (scheduled + live) / kickoff time */}
            <div className="text-right flex-shrink-0 min-w-[72px]">
              {isFinished ? (
                <span className="text-[10px] text-muted/40 font-semibold uppercase">FT</span>
              ) : (
                <>
                  {!isLive && (
                    <p className="text-[10px] text-muted/50 font-mono mb-1">{kickoffLabel(m.kickoff_at)}</p>
                  )}
                  <div className="flex flex-col gap-0.5 items-end">
                    {[
                      { label: '1', val: m.home_odds },
                      { label: 'X', val: m.draw_odds },
                      { label: '2', val: m.away_odds },
                    ].map(o => (
                      <div key={o.label} className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted/40 font-mono w-3">{o.label}</span>
                        <span className={`text-[11px] font-mono font-semibold ${isLive ? 'text-amber-300' : 'text-muted/80'}`}>
                          {o.val?.toFixed(2) ?? '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Live indicator + minute */}
            {isLive && (
              <div className="flex flex-col items-center gap-1 flex-shrink-0 min-w-[34px]">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-[10px] text-amber-400 font-bold font-mono">{minute}'</span>
              </div>
            )}
          </div>
        </button>

        {/* Existing predictions for this match */}
        {preds.length > 0 && (
          <div className="px-4 pb-3 flex flex-wrap gap-1.5">
            {preds.map(p => (
              <div key={p.id} className="flex items-center gap-1.5 bg-surface-2 border border-border rounded-lg px-2 py-1">
                <RiskBadge tier={p.risk_tier} />
                <span className="text-xs font-mono font-semibold">{p.predicted_value}</span>
                <span className="text-[10px] font-mono text-muted">{p.points_wagered}pt</span>
                {p.double_or_nothing && <span className="text-xs text-amber-400">⚡</span>}
                {p.resolved && (
                  <span className={`text-[10px] font-mono font-bold ${(p.points_won ?? 0) > 0 ? 'text-accent' : 'text-danger'}`}>
                    {(p.points_won ?? 0) > 0 ? '+' : ''}{p.points_won}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!activeLeague) return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div>
        <div className="text-5xl mb-3">🏆</div>
        <p className="text-text font-semibold">No league selected</p>
        <p className="text-muted text-sm mt-1">Join or create a league to bet on the World Cup.</p>
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🏆</span>
              <h1 className="text-base font-bold">FIFA World Cup 2026</h1>
            </div>
            <p className="text-xs text-muted mt-0.5 ml-8">USA · Canada · Mexico · Jun 11 – Jul 19</p>
          </div>
          <button onClick={handleSync} disabled={syncing} className="btn-icon">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Live count badge */}
        {liveMatches.length > 0 && (
          <div className="flex items-center gap-2 mb-4 ml-8">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs text-amber-400 font-semibold">{liveMatches.length} match{liveMatches.length > 1 ? 'es' : ''} live now</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-surface-2 rounded-xl p-1">
          {(['upcoming', 'live', 'results'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all ${
                tab === t ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'
              }`}>
              {t === 'live' && liveMatches.length > 0 ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Live
                </span>
              ) : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <div key={i} className="card p-4 animate-pulse h-24 bg-surface-2" />)}
          </div>
        ) : tab === 'upcoming' ? (
          sortedGroups.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-text font-semibold">No upcoming matches</p>
              <button onClick={handleSync} className="btn-ghost mt-4 text-sm">Sync now</button>
            </div>
          ) : (
            sortedGroups.map(grp => (
              <div key={grp} className="mb-5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted/60 mb-2">{grp}</p>
                <div className="card divide-y divide-border overflow-hidden">
                  {upcomingGrouped[grp].map(m => <MatchRow key={m.id} m={m} />)}
                </div>
              </div>
            ))
          )
        ) : tab === 'live' ? (
          liveMatches.length === 0 ? (
            <div className="text-center py-16 text-muted text-sm">No matches live right now.</div>
          ) : (
            <div className="card divide-y divide-border overflow-hidden">
              {liveMatches.map(m => <MatchRow key={m.id} m={m} />)}
            </div>
          )
        ) : (
          // Results
          matches.length === 0 ? (
            <div className="text-center py-16 text-muted text-sm">No results yet.</div>
          ) : (
            <div className="card divide-y divide-border overflow-hidden">
              {matches.map(m => <MatchRow key={m.id} m={m} />)}
            </div>
          )
        )}
      </div>

      {selected && activeLeague && (
        <PredictionModal
          match={selected}
          leagueId={activeLeague.id}
          existingPredictions={predictions.filter(p => p.match_id === selected.id)}
          hasUsedDoubleOrNothing={hasUsedDouble}
          onClose={() => setSelected(null)}
          onSuccess={() => { setSelected(null); loadPredictions() }}
        />
      )}
    </div>
  )
}
