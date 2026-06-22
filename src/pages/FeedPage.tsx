import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { Prediction, Match, User, FeedReaction } from '../types/database'
import { Avatar } from '../components/Avatar'
import { TeamCrest } from '../components/TeamCrest'
import { RiskBadge } from '../components/RiskBadge'
import { estimateLiveMinute } from '../lib/poissonOdds'

interface FeedItem {
  prediction: Prediction
  match: Match
  user: User
  reactions: FeedReaction[]
}

const EMOJIS = ['🔥', '💀', '😂', '🎯', '👀', '💸']
const RESULT_LABELS: Record<string, string> = { '1': 'Home Win', 'X': 'Draw', '2': 'Away Win' }
const BTTS_LABELS: Record<string, string> = { yes: 'Both Score', no: 'Clean Sheet' }

function predLabel(type: string, value: string) {
  if (type === 'result') return RESULT_LABELS[value] ?? value
  if (type === 'btts') return BTTS_LABELS[value] ?? value
  if (type === 'exact_score') return value.replace('-', ' – ')
  return value
}

function typeLabel(type: string) {
  if (type === 'result') return 'Result'
  if (type === 'btts') return 'BTTS'
  if (type === 'exact_score') return 'Exact'
  return type
}

export default function FeedPage() {
  const { authUser } = useAuth()
  const { activeLeague } = useLeague()
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [liveMatches, setLiveMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)

  const loadFeed = useCallback(async () => {
    if (!activeLeague) return
    setLoading(true)

    const { data: predsRaw } = await supabase
      .from('predictions').select('*')
      .eq('league_id', activeLeague.id)
      .order('created_at', { ascending: false }).limit(50)
    const preds = (predsRaw ?? []) as Prediction[]

    if (!preds.length) { setFeed([]); setLoading(false); return }

    const matchIds = [...new Set(preds.map(p => p.match_id))]
    const userIds  = [...new Set(preds.map(p => p.user_id))]
    const predIds  = preds.map(p => p.id)

    const [{ data: matchesRaw }, { data: usersRaw }, { data: reactionsRaw }] = await Promise.all([
      supabase.from('matches').select('*').in('id', matchIds),
      supabase.from('users').select('*').in('id', userIds),
      supabase.from('feed_reactions').select('*').in('bet_id', predIds),
    ])
    const matches   = (matchesRaw   ?? []) as Match[]
    const users     = (usersRaw     ?? []) as User[]
    const reactions = (reactionsRaw ?? []) as FeedReaction[]

    const matchMap = Object.fromEntries(matches.map(m => [m.id, m]))
    const userMap  = Object.fromEntries(users.map(u => [u.id, u]))

    setFeed(
      preds.map(p => ({
        prediction: p,
        match:      matchMap[p.match_id],
        user:       userMap[p.user_id],
        reactions:  reactions.filter(r => r.bet_id === p.id),
      })).filter(i => i.match && i.user)
    )
    setLoading(false)
  }, [activeLeague])

  // Top-of-feed live strip: any match currently in-play across all comps
  const loadLive = useCallback(async () => {
    const { data } = await supabase
      .from('matches').select('*')
      .eq('status', 'live')
      .order('kickoff_at', { ascending: true })
      .limit(8)
    setLiveMatches((data ?? []) as Match[])
  }, [])

  useEffect(() => {
    loadFeed()
    loadLive()
    if (!activeLeague) return
    const channel = supabase.channel(`feed:${activeLeague.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bets', filter: `league_id=eq.${activeLeague.id}` }, () => loadFeed())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feed_reactions' }, () => loadFeed())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => loadLive())
      .subscribe()
    const iv = setInterval(loadLive, 20_000)
    return () => { supabase.removeChannel(channel); clearInterval(iv) }
  }, [activeLeague, loadFeed, loadLive])

  async function toggleReaction(predId: string, emoji: string, existing: FeedReaction[]) {
    if (!authUser) return
    const mine = existing.find(r => r.user_id === authUser.id && r.emoji === emoji)
    if (mine) {
      await supabase.from('feed_reactions').delete().eq('id', mine.id as string)
    } else {
      await supabase.from('feed_reactions').insert({ bet_id: predId, user_id: authUser.id, emoji } as Record<string, unknown>)
    }
    loadFeed()
  }

  if (!activeLeague) return (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <div>
        <div className="text-4xl mb-3">🏆</div>
        <p className="text-text font-semibold">No league yet</p>
        <p className="text-muted text-sm mt-1">Join or create a league to see the feed.</p>
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-lg mx-auto px-4 py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-base font-bold text-text">Feed</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-xs text-muted">Live updates</span>
            </div>
          </div>
        </div>

        {/* Live strip — horizontal scroll of in-play matches, tap to go bet */}
        {liveMatches.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                  {liveMatches.length} live
                </span>
              </div>
              <Link to="/worldcup" className="text-[10px] font-semibold text-muted hover:text-text">View all →</Link>
            </div>
            <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1"
              style={{ scrollbarWidth: 'none' }}>
              {liveMatches.map(m => {
                const min = estimateLiveMinute(m.kickoff_at)
                return (
                  <Link key={m.id} to="/worldcup"
                    className="flex-shrink-0 w-44 card bg-amber-500/5 border-amber-500/20 hover:border-amber-500/40 transition-colors p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="flex items-center gap-1 text-[10px] font-bold text-amber-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        {min >= 90 ? "90+'" : `${min}'`}
                      </span>
                      <span className="text-[9px] font-mono text-muted/50 uppercase truncate ml-2">{m.competition}</span>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <TeamCrest src={m.home_crest} name={m.home_team} size={16} />
                          <span className="text-xs font-semibold truncate">{m.home_team}</span>
                        </div>
                        <span className="font-mono font-bold text-sm text-amber-400 flex-shrink-0">{m.home_score ?? 0}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <TeamCrest src={m.away_crest} name={m.away_team} size={16} />
                          <span className="text-xs font-semibold truncate">{m.away_team}</span>
                        </div>
                        <span className="font-mono font-bold text-sm text-amber-400 flex-shrink-0">{m.away_score ?? 0}</span>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-amber-300 font-semibold">Tap to bet →</div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="card p-4 space-y-3 animate-pulse">
                <div className="flex gap-3">
                  <div className="w-9 h-9 rounded-full bg-surface-3" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-surface-3 rounded w-1/3" />
                    <div className="h-3 bg-surface-3 rounded w-2/3" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : feed.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">👀</div>
            <p className="text-text font-semibold">Nothing here yet</p>
            <p className="text-sm text-muted mt-1">Be the first to make a call.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {feed.map(({ prediction: p, match, user, reactions }) => {
              const isLocked   = new Date(match.kickoff_at) <= new Date()
              const isResolved = p.resolved
              const won  = isResolved && (p.points_won ?? 0) > 0
              const lost = isResolved && (p.points_won ?? 0) < 0

              return (
                <div key={p.id} className={`card p-4 animate-fade-in transition-colors ${
                  won ? 'border-accent/25' : lost ? 'border-danger/20' : ''
                }`}>
                  {/* Top row */}
                  <div className="flex items-start gap-3">
                    <Avatar url={user.avatar_url} username={user.username} size={34} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-text">{user.username}</span>
                          {isLocked && !isResolved && (
                            <span className="pill bg-surface-3 text-muted">locked</span>
                          )}
                          {match.status === 'live' && !isResolved && (
                            <span className="pill bg-danger/15 text-danger">● live</span>
                          )}
                        </div>
                        <span className="text-[10px] text-muted/60 font-mono flex-shrink-0 ml-2">
                          {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                        </span>
                      </div>

                      {/* Match */}
                      <Link
                        to={`/match/${match.id}`}
                        className="flex items-center gap-1.5 mt-1.5 hover:text-text transition-colors group"
                      >
                        <TeamCrest src={match.home_crest} name={match.home_team} size={14} />
                        <span className="text-xs text-muted group-hover:text-text">{match.home_team}</span>
                        <span className="text-muted/30 text-xs">×</span>
                        <span className="text-xs text-muted group-hover:text-text">{match.away_team}</span>
                        <TeamCrest src={match.away_crest} name={match.away_team} size={14} />
                      </Link>
                    </div>
                  </div>

                  {/* Prediction pill */}
                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-muted/60 font-mono uppercase">{typeLabel(p.prediction_type)}</span>
                      <span className="font-semibold text-sm text-text">{predLabel(p.prediction_type, p.predicted_value)}</span>
                      <RiskBadge tier={p.risk_tier} />
                      {p.double_or_nothing && (
                        <span className="text-[10px] font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded-md">⚡ DNO</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                      {isResolved ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`font-mono text-sm font-bold ${won ? 'text-accent' : 'text-danger'}`}>
                            {(p.points_won ?? 0) > 0 ? '+' : ''}{p.points_won}
                          </span>
                          <span className={`pill ${won ? 'bg-accent/15 text-accent' : 'bg-danger/15 text-danger'}`}>
                            {won ? 'WIN' : 'LOSS'}
                          </span>
                        </div>
                      ) : (
                        <span className="font-mono text-xs text-muted">{p.points_wagered} pts</span>
                      )}
                    </div>
                  </div>

                  {/* Hot take */}
                  {p.reasoning && (
                    <p className="mt-2.5 text-[13px] text-text/85 italic leading-snug border-l-2 border-accent/30 pl-3">
                      “{p.reasoning}”
                    </p>
                  )}

                  {/* Reactions */}
                  <div className="mt-3 flex items-center gap-1 flex-wrap">
                    {EMOJIS.map(emoji => {
                      const count = reactions.filter(r => r.emoji === emoji).length
                      const mine  = reactions.some(r => r.user_id === authUser?.id && r.emoji === emoji)
                      if (count === 0 && !mine) return (
                        <button key={emoji} onClick={() => toggleReaction(p.id, emoji, reactions)}
                          className="w-8 h-7 flex items-center justify-center rounded-lg text-sm bg-surface-2 hover:bg-surface-3 transition-colors text-muted/50 hover:text-text">
                          {emoji}
                        </button>
                      )
                      return (
                        <button key={emoji} onClick={() => toggleReaction(p.id, emoji, reactions)}
                          className={`flex items-center gap-1 px-2 h-7 rounded-lg text-sm transition-all duration-100 ${
                            mine ? 'bg-accent/15 border border-accent/30 text-accent' : 'bg-surface-2 hover:bg-surface-3 text-text'
                          }`}>
                          {emoji}
                          <span className="text-[10px] font-mono font-semibold">{count}</span>
                        </button>
                      )
                    })}
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
