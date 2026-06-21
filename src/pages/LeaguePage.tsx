import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Copy, Check, Users, Plus, LogIn, Crown, Trophy, Swords } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { User, LeagueMember, League, Prediction } from '../types/database'
import { Avatar } from '../components/Avatar'

interface MemberWithUser { member: LeagueMember; user: User }

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

export default function LeaguePage() {
  const { authUser } = useAuth()
  const { activeLeague, leagues, setActiveLeague, reload } = useLeague()
  const [members, setMembers] = useState<MemberWithUser[]>([])
  const [standings, setStandings] = useState<Standing[]>([])
  const [allPreds, setAllPreds] = useState<Prediction[]>([])
  const [view, setView] = useState<'members' | 'leaderboard' | 'rivals'>('members')
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<'overview' | 'create' | 'join'>('overview')
  const [createName, setCreateName] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)
  const [joinError, setJoinError] = useState('')

  useEffect(() => {
    if (!activeLeague) return
    ;(async () => {
      const { data: dataRaw } = await supabase.from('league_members').select('*')
        .eq('league_id', activeLeague.id).order('total_points', { ascending: false })
      const data = (dataRaw ?? []) as LeagueMember[]
      if (!data.length) { setMembers([]); setStandings([]); return }
      const userIds = data.map(m => m.user_id)
      const { data: usersRaw } = await supabase.from('users').select('*').in('id', userIds)
      const users = (usersRaw ?? []) as User[]
      const userMap = Object.fromEntries(users.map(u => [u.id, u]))
      setMembers(data.map(m => ({ member: m, user: userMap[m.user_id] })).filter(x => x.user))

      // Standings with win-rate + streak (powers Leaderboard view)
      const { data: predsRaw } = await supabase.from('predictions').select('*')
        .eq('league_id', activeLeague.id).eq('resolved', true).in('user_id', userIds)
      const preds = (predsRaw ?? []) as Prediction[]
      setAllPreds(preds)
      setStandings(data.map(m => {
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
      }).filter(s => s.user))
    })()
  }, [activeLeague])

  // ── Rivalries: head-to-head record on matches we both bet on ─────────
  // Per match, whoever scored more points wins that round. Ties when
  // both scored the same. Aggregated over every resolved shared match.
  const rivals = useMemo(() => {
    if (!authUser) return [] as { user: User; wins: number; losses: number; ties: number; shared: number; pointsGap: number }[]
    const myPreds = allPreds.filter(p => p.user_id === authUser.id)
    const myByMatch = new Map(myPreds.map(p => [p.match_id, p]))
    const me = standings.find(s => s.user?.id === authUser.id)
    const myPts = me?.member.total_points ?? 0

    return standings
      .filter(s => s.user?.id !== authUser.id)
      .map(s => {
        const theirPreds = allPreds.filter(p => p.user_id === s.user.id)
        let wins = 0, losses = 0, ties = 0, shared = 0
        for (const tp of theirPreds) {
          const mp = myByMatch.get(tp.match_id)
          if (!mp) continue
          shared++
          const mine = mp.points_won ?? 0
          const theirs = tp.points_won ?? 0
          if      (mine > theirs) wins++
          else if (mine < theirs) losses++
          else                    ties++
        }
        return {
          user: s.user,
          wins, losses, ties, shared,
          pointsGap: s.member.total_points - myPts,
        }
      })
      .sort((a, b) => {
        // Order: most shared games first, then closest gap, then by wins
        if (b.shared !== a.shared) return b.shared - a.shared
        if (Math.abs(a.pointsGap) !== Math.abs(b.pointsGap)) return Math.abs(a.pointsGap) - Math.abs(b.pointsGap)
        return b.wins - a.wins
      })
  }, [authUser, allPreds, standings])

  async function copyCode() {
    if (!activeLeague) return
    await navigator.clipboard.writeText(activeLeague.invite_code)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!authUser) return
    setCreateError(''); setCreateLoading(true)
    const { data: leagueRaw, error } = await supabase.from('leagues')
      .insert({ name: createName, created_by: authUser.id } as Record<string, unknown>)
      .select().single()
    const league = leagueRaw as League | null
    if (error || !league) { setCreateError(error?.message ?? 'Failed'); setCreateLoading(false); return }
    await supabase.from('league_members').insert({ league_id: league.id, user_id: authUser.id } as Record<string, unknown>)
    await reload(); setActiveLeague(league); setCreateName(''); setTab('overview'); setCreateLoading(false)
  }

  async function handleJoin(e: FormEvent) {
    e.preventDefault()
    if (!authUser) return
    setJoinError(''); setJoinLoading(true)
    const { data: leagueJoinRaw, error: leagueErr } = await supabase.from('leagues').select('*')
      .eq('invite_code', joinCode.toUpperCase().trim()).single()
    const league = leagueJoinRaw as League | null
    if (leagueErr || !league) { setJoinError('Invalid invite code'); setJoinLoading(false); return }
    const { error: memberErr } = await supabase.from('league_members')
      .insert({ league_id: league.id, user_id: authUser.id } as Record<string, unknown>)
    if (memberErr) { setJoinError(memberErr.code === '23505' ? 'Already a member' : memberErr.message); setJoinLoading(false); return }
    await reload(); setActiveLeague(league); setJoinCode(''); setTab('overview'); setJoinLoading(false)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-base font-bold">League</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => setTab('join')} className="btn-ghost py-2 px-3 flex items-center gap-1.5">
              <LogIn size={13} /> Join
            </button>
            <button onClick={() => setTab('create')} className="btn-primary py-2 px-3 flex items-center gap-1.5">
              <Plus size={13} /> Create
            </button>
          </div>
        </div>

        {/* League switcher */}
        {leagues.length > 1 && (
          <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
            {leagues.map(l => (
              <button key={l.id} onClick={() => { setActiveLeague(l); setTab('overview') }}
                className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                  activeLeague?.id === l.id ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-muted hover:text-text'
                }`}>
                {l.name}
              </button>
            ))}
          </div>
        )}

        {/* Create form */}
        {tab === 'create' && (
          <div className="card p-5 mb-4 animate-fade-in">
            <h2 className="font-bold mb-4">Create League</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div><label className="label">League Name</label>
                <input className="input" type="text" placeholder="Sunday Carnage FC" value={createName} onChange={e => setCreateName(e.target.value)} required />
              </div>
              {createError && <p className="text-danger text-xs">{createError}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => setTab('overview')} className="btn-ghost flex-1">Cancel</button>
                <button type="submit" disabled={createLoading} className="btn-primary flex-1">{createLoading ? '…' : 'Create'}</button>
              </div>
            </form>
          </div>
        )}

        {/* Join form */}
        {tab === 'join' && (
          <div className="card p-5 mb-4 animate-fade-in">
            <h2 className="font-bold mb-4">Join League</h2>
            <form onSubmit={handleJoin} className="space-y-4">
              <div><label className="label">Invite Code</label>
                <input className="input font-mono text-center text-2xl font-bold uppercase tracking-widest py-4"
                  type="text" placeholder="XXXXXXXX" value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={8} required />
              </div>
              {joinError && <p className="text-danger text-xs">{joinError}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => setTab('overview')} className="btn-ghost flex-1">Cancel</button>
                <button type="submit" disabled={joinLoading} className="btn-primary flex-1">{joinLoading ? '…' : 'Join'}</button>
              </div>
            </form>
          </div>
        )}

        {!activeLeague ? (
          <div className="text-center py-20">
            <Users size={36} className="text-muted/40 mx-auto mb-3" />
            <p className="text-text font-semibold">No leagues yet</p>
            <p className="text-sm text-muted mt-1">Create or join one to get started.</p>
          </div>
        ) : (
          <>
            {/* League card */}
            <div className="card p-5 mb-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-bold text-lg leading-tight">{activeLeague.name}</h2>
                  <p className="text-xs text-muted mt-1">{activeLeague.season} · {activeLeague.sport}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="label">Invite Code</p>
                  <button onClick={copyCode}
                    className="flex items-center gap-2 bg-surface-2 border border-border rounded-xl px-3.5 py-2 hover:border-white/15 transition-colors">
                    <span className="font-mono font-bold tracking-widest text-sm text-text">{activeLeague.invite_code}</span>
                    {copied
                      ? <Check size={13} className="text-accent" />
                      : <Copy size={13} className="text-muted" />
                    }
                  </button>
                </div>
              </div>
            </div>

            {/* View toggle: Members / Leaderboard / Rivals */}
            <div className="flex gap-1 mb-3 bg-surface-2 rounded-xl p-1">
              {(['members', 'leaderboard', 'rivals'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all flex items-center justify-center gap-1.5 ${
                    view === v ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'
                  }`}>
                  {v === 'members'     ? <Users size={12} /> :
                   v === 'leaderboard' ? <Trophy size={12} /> :
                                          <Swords size={12} />}
                  {v}
                </button>
              ))}
            </div>

            {view === 'rivals' ? (
              rivals.length === 0 ? (
                <div className="text-center py-12 card">
                  <Swords size={28} className="text-muted/30 mx-auto mb-3" />
                  <p className="text-sm font-semibold text-text">No rivals yet</p>
                  <p className="text-xs text-muted mt-1">Bet on the same matches as others to build a record.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Highlight: top rival = most shared bets */}
                  {rivals[0] && rivals[0].shared > 0 && (
                    <div className="card p-4 border-accent/20 bg-accent/[0.04]">
                      <p className="text-[10px] font-semibold text-accent uppercase tracking-wider mb-2">Your Top Rival</p>
                      <div className="flex items-center gap-3">
                        <Avatar url={rivals[0].user.avatar_url} username={rivals[0].user.username} size={40} />
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm text-text truncate">{rivals[0].user.username}</p>
                          <p className="text-[11px] text-muted mt-0.5">
                            {rivals[0].shared} shared {rivals[0].shared === 1 ? 'match' : 'matches'} ·
                            {' '}{rivals[0].pointsGap > 0
                              ? <span className="text-danger">{rivals[0].pointsGap} pts ahead</span>
                              : rivals[0].pointsGap < 0
                                ? <span className="text-accent">{Math.abs(rivals[0].pointsGap)} pts behind</span>
                                : <span>tied with you</span>}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-base font-bold text-text">
                            <span className="text-accent">{rivals[0].wins}</span>
                            <span className="text-muted/50">-</span>
                            <span className="text-danger">{rivals[0].losses}</span>
                            {rivals[0].ties > 0 && (
                              <>
                                <span className="text-muted/50">-</span>
                                <span className="text-muted">{rivals[0].ties}</span>
                              </>
                            )}
                          </p>
                          <p className="text-[9px] font-mono text-muted/50 uppercase">W-L{rivals[0].ties > 0 ? '-T' : ''}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="card overflow-hidden">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Swords size={13} className="text-muted" />
                        <span className="text-xs font-semibold text-muted">Head-to-Head</span>
                      </div>
                      <span className="text-[10px] font-mono text-muted/60">vs you</span>
                    </div>
                    <div className="divide-y divide-border">
                      {rivals.map(r => (
                        <div key={r.user.id} className="flex items-center gap-3 px-4 py-3">
                          <Avatar url={r.user.avatar_url} username={r.user.username} size={32} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-text truncate">{r.user.username}</p>
                            <p className="text-[10px] font-mono text-muted/60 mt-0.5">
                              {r.shared > 0
                                ? `${r.shared} shared bet${r.shared === 1 ? '' : 's'}`
                                : 'no shared bets yet'}
                              {r.pointsGap !== 0 && (
                                <> · {r.pointsGap > 0 ? '+' : ''}{r.pointsGap} pts</>
                              )}
                            </p>
                          </div>
                          {r.shared > 0 && (
                            <span className="font-mono text-sm font-bold flex-shrink-0">
                              <span className="text-accent">{r.wins}</span>
                              <span className="text-muted/40">-</span>
                              <span className="text-danger">{r.losses}</span>
                              {r.ties > 0 && (
                                <>
                                  <span className="text-muted/40">-</span>
                                  <span className="text-muted">{r.ties}</span>
                                </>
                              )}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            ) : view === 'members' ? (
              <div className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <Users size={13} className="text-muted" />
                  <span className="text-xs font-semibold text-muted">{members.length} members</span>
                </div>
                <div className="divide-y divide-border">
                  {members.map(({ member, user }, idx) => (
                    <div key={member.id} className="flex items-center gap-3 px-4 py-3.5">
                      <span className="text-[10px] font-mono text-muted/40 w-4 text-center">{idx + 1}</span>
                      <Avatar url={user?.avatar_url} username={user?.username ?? '?'} size={30} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold truncate">{user?.username ?? 'Unknown'}</span>
                          {user?.id === authUser?.id && (
                            <span className="text-[9px] text-muted font-semibold uppercase tracking-wider">you</span>
                          )}
                          {user?.id === activeLeague.created_by && (
                            <Crown size={11} className="text-amber-400 flex-shrink-0" />
                          )}
                        </div>
                      </div>
                      <span className={`font-mono text-sm font-bold ${
                        member.total_points > 0 ? 'text-accent' : member.total_points < 0 ? 'text-danger' : 'text-muted/40'
                      }`}>
                        {member.total_points > 0 ? '+' : ''}{member.total_points}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
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

                {/* Full ranked list */}
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
          </>
        )}
      </div>
    </div>
  )
}
