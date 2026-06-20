import { useEffect, useState, type FormEvent } from 'react'
import { Copy, Check, Users, Plus, LogIn, Crown } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { User, LeagueMember, League } from '../types/database'
import { Avatar } from '../components/Avatar'

interface MemberWithUser { member: LeagueMember; user: User }

export default function LeaguePage() {
  const { authUser } = useAuth()
  const { activeLeague, leagues, setActiveLeague, reload } = useLeague()
  const [members, setMembers] = useState<MemberWithUser[]>([])
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
      if (!data.length) { setMembers([]); return }
      const { data: usersRaw } = await supabase.from('users').select('*').in('id', data.map(m => m.user_id))
      const users = (usersRaw ?? []) as User[]
      const userMap = Object.fromEntries(users.map(u => [u.id, u]))
      setMembers(data.map(m => ({ member: m, user: userMap[m.user_id] })).filter(x => x.user))
    })()
  }, [activeLeague])

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

            {/* Members */}
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
          </>
        )}
      </div>
    </div>
  )
}
