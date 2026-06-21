import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import type { League } from '../types/database'

type State =
  | { phase: 'loading' }
  | { phase: 'success'; league: League; alreadyMember: boolean }
  | { phase: 'error'; message: string }

/**
 * Public-but-protected join landing page. Reached via shareable
 * /join/<INVITE_CODE> links. Looks up the league, inserts the user as
 * a member (no-op if already there), then bounces to /league with that
 * league active.
 */
export default function JoinPage() {
  const { code = '' } = useParams<{ code: string }>()
  const { authUser } = useAuth()
  const { setActiveLeague, reload } = useLeague()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    if (!authUser) return
    const normalized = code.trim().toUpperCase()
    if (!normalized) { setState({ phase: 'error', message: 'No invite code in this link.' }); return }

    ;(async () => {
      const { data: leagueRaw, error: leagueErr } = await supabase
        .from('leagues').select('*').eq('invite_code', normalized).maybeSingle()
      const league = leagueRaw as League | null

      if (leagueErr || !league) {
        setState({ phase: 'error', message: 'That invite code doesn\'t match any league.' })
        return
      }

      // Try to insert membership — unique constraint on (league_id, user_id) means
      // a duplicate just bounces with code 23505, which we treat as "already joined".
      const { error: insertErr } = await supabase
        .from('league_members')
        .insert({ league_id: league.id, user_id: authUser.id } as Record<string, unknown>)

      const alreadyMember = insertErr?.code === '23505'
      if (insertErr && !alreadyMember) {
        setState({ phase: 'error', message: insertErr.message })
        return
      }

      await reload()
      setActiveLeague(league)
      setState({ phase: 'success', league, alreadyMember })

      // Brief pause so the user sees the confirmation before redirect.
      setTimeout(() => navigate('/league', { replace: true }), 1400)
    })()
  }, [authUser, code, setActiveLeague, reload, navigate])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-sm mx-auto px-4 py-16 text-center">
        {state.phase === 'loading' && (
          <>
            <div className="text-3xl mb-3 animate-pulse">🔗</div>
            <p className="font-bold text-base">Joining league…</p>
            <p className="text-xs text-muted mt-1.5 font-mono uppercase tracking-widest">{code}</p>
          </>
        )}

        {state.phase === 'success' && (
          <>
            <CheckCircle2 size={40} className="mx-auto text-accent mb-3" />
            <p className="font-bold text-base">
              {state.alreadyMember ? 'You\'re already in!' : 'Welcome to the league!'}
            </p>
            <p className="text-sm text-text mt-1">{state.league.name}</p>
            <p className="text-xs text-muted mt-3">Taking you in…</p>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <XCircle size={40} className="mx-auto text-danger mb-3" />
            <p className="font-bold text-base">Couldn't join</p>
            <p className="text-sm text-muted mt-1.5 leading-snug">{state.message}</p>
            <Link to="/league" className="inline-block mt-5 text-sm text-accent font-semibold">
              Go to your leagues →
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
