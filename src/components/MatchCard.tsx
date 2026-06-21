import { format } from 'date-fns'
import type { Match } from '../types/database'
import { TeamCrest } from './TeamCrest'

interface Props {
  match: Match
  onClick?: () => void
  selected?: boolean
}

export function MatchCard({ match, onClick, selected }: Props) {
  const kickoff = new Date(match.kickoff_at)
  const isLive     = match.status === 'live'
  const isFinished = match.status === 'finished'

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`w-full text-left rounded-2xl border p-4 transition-all duration-150 ${
        onClick ? 'cursor-pointer hover:border-white/15 active:scale-[0.99]' : 'cursor-default'
      } ${
        selected
          ? 'border-accent/40 bg-accent/5'
          : 'border-border bg-surface'
      }`}
    >
      {/* Top meta */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold text-muted/60 uppercase tracking-wider">{match.competition}</span>
        <div className="flex items-center gap-1.5">
          {isLive && <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />}
          <span className={`text-[10px] font-mono font-semibold ${isLive ? 'text-danger' : 'text-muted/60'}`}>
            {isLive ? 'LIVE' : isFinished ? 'FT' : format(kickoff, 'EEE HH:mm')}
          </span>
        </div>
      </div>

      {/* Teams + score */}
      <div className="flex items-center gap-3">
        {/* Home */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <TeamCrest src={match.home_crest} name={match.home_team} size={26} />
          <span className="text-sm font-semibold text-text truncate">{match.home_team}</span>
        </div>

        {/* Score / vs */}
        <div className="flex-shrink-0 w-16 text-center">
          {isFinished || isLive ? (
            <div className={`font-mono font-bold text-base ${isLive ? 'text-danger' : 'text-text'}`}>
              {match.home_score ?? 0}<span className="text-muted/40 mx-1">–</span>{match.away_score ?? 0}
            </div>
          ) : (
            <div className="text-muted/40 text-xs font-mono">vs</div>
          )}
        </div>

        {/* Away */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0 justify-end">
          <span className="text-sm font-semibold text-text truncate text-right">{match.away_team}</span>
          <TeamCrest src={match.away_crest} name={match.away_team} size={26} />
        </div>
      </div>

    </button>
  )
}
