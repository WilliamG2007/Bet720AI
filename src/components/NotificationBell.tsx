import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import type { Notification, NotificationType } from '../types/database'

const PAGE_SIZE = 20

/**
 * Bell icon in the header. Persistent notification store:
 *   - Loads the last 20 rows on mount and subscribes via realtime.
 *   - Unread badge counts unseen rows.
 *   - Clicking opens a dropdown; opening the dropdown marks all read
 *     via the mark_all_notifications_read RPC.
 *
 * Triggers in supabase/notifications.sql are the only writers — we never
 * insert from the client.
 */
export function NotificationBell() {
  const { authUser } = useAuth()
  const [notifs, setNotifs] = useState<Notification[]>([])
  const [open, setOpen]     = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (!authUser) return
    const { data } = await supabase
      .from('notifications').select('*')
      .eq('user_id', authUser.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)
    setNotifs((data ?? []) as Notification[])
  }, [authUser])

  // Initial load + realtime subscription
  useEffect(() => {
    if (!authUser) return
    load()
    const ch = supabase
      .channel(`notifs:${authUser.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${authUser.id}`,
      }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [authUser, load])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  const unread = notifs.filter(n => n.read_at == null).length

  async function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      // Optimistic — mark all locally, fire the RPC in the background
      setNotifs(prev => prev.map(n => n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
      await supabase.rpc('mark_all_notifications_read')
    }
  }

  if (!authUser) return null

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={toggleOpen}
        aria-label="Notifications"
        className="relative w-9 h-9 flex items-center justify-center rounded-lg text-muted hover:text-text hover:bg-surface-2 transition-colors"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-bg text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 max-h-[70vh] overflow-y-auto bg-surface border border-border rounded-2xl shadow-2xl animate-slide-up">
          <div className="sticky top-0 bg-surface border-b border-border px-4 py-3">
            <p className="text-sm font-bold text-text">Notifications</p>
          </div>

          {notifs.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <div className="text-3xl mb-2 opacity-50">🔔</div>
              <p className="text-sm text-muted">No notifications yet</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifs.map(n => <NotifRow key={n.id} n={n} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Row rendering ─────────────────────────────────────────────────────

function NotifRow({ n }: { n: Notification }) {
  const p = n.payload as Record<string, unknown>
  return (
    <li className={`px-4 py-3 ${n.read_at ? '' : 'bg-accent/[0.03]'}`}>
      <div className="flex items-start gap-3">
        <span className="text-base flex-shrink-0 leading-none mt-0.5">{iconFor(n.type, p)}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text leading-snug">{titleFor(n.type, p)}</p>
          {subtitleFor(n.type, p) && (
            <p className="text-[11px] text-muted mt-0.5 leading-snug">{subtitleFor(n.type, p)}</p>
          )}
          <p className="text-[10px] text-muted/50 mt-1 font-mono">
            {formatDistanceToNowStrict(new Date(n.created_at), { addSuffix: true })}
          </p>
        </div>
        {!n.read_at && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-1.5" />}
      </div>
    </li>
  )
}

function iconFor(type: NotificationType, p: Record<string, unknown>): string {
  if (type === 'bet_settled')  return p.won ? '🎯' : '💔'
  if (type === 'rival_bet')    return '⚔️'
  if (type === 'league_join')  return '👋'
  return '🔔'
}

function titleFor(type: NotificationType, p: Record<string, unknown>): string {
  if (type === 'bet_settled') {
    const points = (p.points_won as number) ?? 0
    return p.won ? `You won ${points} pts` : `You lost ${Math.abs(points)} pts`
  }
  if (type === 'rival_bet') return `${p.actor_name ?? 'Someone'} placed a bet`
  if (type === 'league_join') return `${p.joiner_name ?? 'Someone'} joined ${p.league_name ?? 'your league'}`
  return ''
}

function subtitleFor(type: NotificationType, p: Record<string, unknown>): string | null {
  const match = p.home_team && p.away_team ? `${p.home_team} vs ${p.away_team}` : null
  if (type === 'bet_settled' && match) {
    return `${match} · finished ${p.home_score ?? 0}–${p.away_score ?? 0}`
  }
  if (type === 'rival_bet' && match) {
    return `${match} · ${p.points ?? 0} pts on ${p.predicted ?? ''}`
  }
  return null
}
