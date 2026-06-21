import { NavLink, Outlet } from 'react-router-dom'
import { Rss, Target, Shield, ReceiptText } from 'lucide-react'
import { useLeague } from '../contexts/LeagueContext'
import { ResolutionToast } from './ResolutionToast'

const NAV = [
  { to: '/',            icon: Rss,         label: 'Feed',    emoji: null },
  { to: '/worldcup',    icon: null,        label: 'WC',      emoji: '🏆' },
  { to: '/predict',     icon: Target,      label: 'Predict', emoji: null },
  { to: '/league',      icon: Shield,      label: 'League',  emoji: null },
  { to: '/bets',        icon: ReceiptText, label: 'Bets',    emoji: null },
]

export function Layout() {
  const { activeLeague } = useLeague()

  return (
    <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-bg">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-5 h-14 border-b border-border bg-bg/90 backdrop-blur-md">
        <div className="flex items-baseline gap-0.5">
          <span className="font-extrabold text-lg tracking-tight text-text">bet</span>
          <span className="font-extrabold text-lg tracking-tight text-accent">720</span>
        </div>
        {activeLeague && (
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="text-xs text-muted font-medium truncate max-w-[140px]">{activeLeague.name}</span>
          </div>
        )}
      </header>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <Outlet />
      </main>

      <ResolutionToast />

      {/* Bottom Nav */}
      <nav className="flex-shrink-0 flex border-t border-border bg-bg/90 backdrop-blur-md pb-safe">
        {NAV.map(({ to, icon: Icon, label, emoji }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center gap-1 py-3 transition-all duration-150 relative ${
                isActive ? 'text-accent' : 'text-muted hover:text-text'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-accent rounded-full" />
                )}
                {emoji
                  ? <span className="text-xl leading-none">{emoji}</span>
                  : Icon && <Icon size={19} strokeWidth={isActive ? 2 : 1.75} />
                }
                <span className="text-[9px] font-semibold uppercase tracking-wider">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
