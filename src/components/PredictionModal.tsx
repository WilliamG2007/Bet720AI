import { useState, useEffect } from 'react'
import { X, Zap } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import type { Match, Prediction, PredictionType, RiskTier } from '../types/database'
import { TeamCrest } from './TeamCrest'
import { RiskBadge } from './RiskBadge'
import {
  exactScoreDecimalOdds,
  decimalToMultiplier,
  oddsToRiskTier,
  DEFAULT_MATCH_ODDS,
} from '../lib/poissonOdds'

interface Props {
  match: Match
  leagueId: string
  existingPredictions: Prediction[]
  hasUsedDoubleOrNothing: boolean
  onClose: () => void
  onSuccess: () => void
}

function fmtOdds(d: number): string {
  return `×${d.toFixed(2)}`
}

export function PredictionModal({ match, leagueId, existingPredictions, hasUsedDoubleOrNothing, onClose, onSuccess }: Props) {
  const { authUser } = useAuth()
  const [predType, setPredType]     = useState<PredictionType>('result')
  const [resultPick, setResultPick] = useState<'1' | 'X' | '2'>('1')
  const [bttsPick, setBttsPick]     = useState<'yes' | 'no'>('yes')
  const [homeScore, setHomeScore]   = useState('1')
  const [awayScore, setAwayScore]   = useState('0')
  const [points, setPoints]         = useState(25)
  const [dbl, setDbl]               = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  // Use match odds if available, fall back to neutral defaults
  const baseOdds = {
    home:     match.home_odds     ?? DEFAULT_MATCH_ODDS.home,
    draw:     match.draw_odds     ?? DEFAULT_MATCH_ODDS.draw,
    away:     match.away_odds     ?? DEFAULT_MATCH_ODDS.away,
    bttsYes:  match.btts_yes_odds ?? DEFAULT_MATCH_ODDS.bttsYes,
    bttsNo:   match.btts_no_odds  ?? DEFAULT_MATCH_ODDS.bttsNo,
    homeExp:  match.expected_home_goals ?? DEFAULT_MATCH_ODDS.homeExpected,
    awayExp:  match.expected_away_goals ?? DEFAULT_MATCH_ODDS.awayExpected,
  }

  // Decimal odds for the currently selected pick
  function currentDecimalOdds(): number {
    if (predType === 'result') {
      return resultPick === '1' ? baseOdds.home : resultPick === 'X' ? baseOdds.draw : baseOdds.away
    }
    if (predType === 'btts') {
      return bttsPick === 'yes' ? baseOdds.bttsYes : baseOdds.bttsNo
    }
    // exact_score — for live matches, condition on the goals already scored
    const h = parseInt(homeScore) || 0
    const a = parseInt(awayScore) || 0
    const curHome = match.status === 'live' ? (match.home_score ?? 0) : 0
    const curAway = match.status === 'live' ? (match.away_score ?? 0) : 0
    return exactScoreDecimalOdds(baseOdds.homeExp, baseOdds.awayExp, h, a, curHome, curAway)
  }

  const decOdds    = currentDecimalOdds()
  const netMult    = decimalToMultiplier(decOdds)            // profit multiplier (decimal - 1)
  const finalMult  = dbl ? netMult * 2 : netMult
  const riskTier: RiskTier = oddsToRiskTier(netMult)

  const potential  = Math.round(points * finalMult)
  const maxLoss    = dbl ? points * 2 : points

  // Live (in-play) matches remain bettable; only finished/postponed lock.
  const isLive     = match.status === 'live'
  const isLocked   = match.status === 'finished' || match.status === 'postponed'
  const existing   = existingPredictions.find(p => p.prediction_type === predType)

  function getValue() {
    if (predType === 'result') return resultPick
    if (predType === 'btts') return bttsPick
    return `${homeScore}-${awayScore}`
  }

  useEffect(() => {
    if (!existing) return
    const v = existing.predicted_value
    if (predType === 'result') setResultPick(v as '1' | 'X' | '2')
    if (predType === 'btts') setBttsPick(v as 'yes' | 'no')
    if (predType === 'exact_score') {
      const [h, a] = v.split('-')
      setHomeScore(h || '1')
      setAwayScore(a || '0')
    }
    setPoints(existing.points_wagered)
    setDbl(existing.double_or_nothing)
  }, [predType])

  async function handleSubmit() {
    if (!authUser || isLocked) return
    setError(''); setLoading(true)

    const row: Record<string, unknown> = {
      user_id:            authUser.id,
      match_id:           match.id,
      league_id:          leagueId,
      prediction_type:    predType,
      predicted_value:    getValue(),
      risk_tier:          riskTier,
      points_wagered:     points,
      double_or_nothing:  dbl,
      resolved:           false,
      odds_multiplier:    netMult,   // store net-profit mult (decimal - 1)
    }

    const { error: err } = existing
      ? await supabase.from('predictions').update(row).eq('id', existing.id as string)
      : await supabase.from('predictions').insert(row)

    if (err) setError(err.message)
    else onSuccess()
    setLoading(false)
  }

  const dblBlocked = hasUsedDoubleOrNothing && !dbl && !existing?.double_or_nothing

  // Odds for the three result picks
  const resultOdds = { '1': baseOdds.home, 'X': baseOdds.draw, '2': baseOdds.away }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="card w-full max-w-md animate-slide-up max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-surface flex items-center justify-between px-5 py-4 border-b border-border rounded-t-2xl z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2">
              <TeamCrest src={match.home_crest} name={match.home_team} size={22} />
              <span className="text-sm font-bold text-text truncate max-w-[80px]">{match.home_team}</span>
            </div>
            <span className="text-muted/40 text-xs font-mono">vs</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-text truncate max-w-[80px]">{match.away_team}</span>
              <TeamCrest src={match.away_crest} name={match.away_team} size={22} />
            </div>
          </div>
          <button onClick={onClose} className="btn-icon flex-shrink-0 ml-2">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-6">
          {isLocked && (
            <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3 text-danger text-sm font-medium">
              Predictions locked — match has finished.
            </div>
          )}

          {isLive && !isLocked && (
            <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
              <div>
                <p className="text-amber-400 text-sm font-semibold">In-Play Betting · {match.home_score ?? 0}–{match.away_score ?? 0}</p>
                <p className="text-[11px] text-muted mt-0.5">Odds reflect the live score &amp; time remaining. Locked in when you bet.</p>
              </div>
            </div>
          )}

          {/* Type selector */}
          <div>
            <p className="label">Prediction Type</p>
            <div className="space-y-2">
              {([
                { type: 'result'      as PredictionType, label: 'Match Result',     sub: '1 / X / 2', oddsRange: `${fmtOdds(Math.min(baseOdds.home, baseOdds.away))} – ${fmtOdds(Math.max(baseOdds.home, baseOdds.away))}` },
                { type: 'btts'        as PredictionType, label: 'Both Teams Score', sub: 'Yes / No',   oddsRange: `${fmtOdds(Math.min(baseOdds.bttsYes, baseOdds.bttsNo))} – ${fmtOdds(Math.max(baseOdds.bttsYes, baseOdds.bttsNo))}` },
                { type: 'exact_score' as PredictionType, label: 'Exact Score',      sub: 'e.g. 2 – 1', oddsRange: 'varies' },
              ]).map(t => (
                <button key={t.type} onClick={() => setPredType(t.type)} disabled={isLocked}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-100 ${
                    predType === t.type ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-white/10'
                  }`}>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-text">{t.label}</p>
                    <p className="text-xs text-muted mt-0.5">{t.sub}</p>
                  </div>
                  <span className="text-xs font-mono text-muted/60 ml-3">{t.oddsRange}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Pick */}
          <div>
            <p className="label">Your Pick</p>

            {predType === 'result' && (
              <div className="grid grid-cols-3 gap-2">
                {(['1', 'X', '2'] as const).map(v => {
                  const d = resultOdds[v]
                  const selected = resultPick === v
                  return (
                    <button key={v} onClick={() => setResultPick(v)} disabled={isLocked}
                      className={`py-3.5 px-1 rounded-xl border text-center transition-all duration-100 ${
                        selected ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                      }`}>
                      <div className={`text-[11px] font-semibold leading-tight mb-1 truncate ${selected ? 'text-accent' : 'text-text'}`}>
                        {v === '1' ? match.home_team : v === '2' ? match.away_team : 'Draw'}
                      </div>
                      <div className={`text-[10px] font-mono mt-0.5 ${selected ? 'text-accent/70' : 'text-muted/60'}`}>{fmtOdds(d)}</div>
                    </button>
                  )
                })}
              </div>
            )}

            {predType === 'btts' && (
              <div className="grid grid-cols-2 gap-2">
                {(['yes', 'no'] as const).map(v => {
                  const d = v === 'yes' ? baseOdds.bttsYes : baseOdds.bttsNo
                  const selected = bttsPick === v
                  return (
                    <button key={v} onClick={() => setBttsPick(v)} disabled={isLocked}
                      className={`py-4 rounded-xl border text-center transition-all duration-100 ${
                        selected ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                      }`}>
                      <div className={`font-bold text-sm ${selected ? 'text-accent' : 'text-text'}`}>
                        {v === 'yes' ? '⚽ Yes' : '🧤 No'}
                      </div>
                      <div className={`text-[11px] font-mono mt-1 ${selected ? 'text-accent/70' : 'text-muted/60'}`}>{fmtOdds(d)}</div>
                    </button>
                  )
                })}
              </div>
            )}

            {predType === 'exact_score' && (
              <div className="space-y-3">
                <div className="flex items-end gap-4 justify-center">
                  <div className="text-center">
                    <p className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-2">{match.home_team}</p>
                    <input type="number" min="0" max="20" value={homeScore}
                      onChange={e => setHomeScore(e.target.value)} disabled={isLocked}
                      className="input w-20 text-center font-mono text-2xl font-bold py-3" />
                  </div>
                  <div className="text-3xl font-mono text-muted/40 pb-2">–</div>
                  <div className="text-center">
                    <p className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-2">{match.away_team}</p>
                    <input type="number" min="0" max="20" value={awayScore}
                      onChange={e => setAwayScore(e.target.value)} disabled={isLocked}
                      className="input w-20 text-center font-mono text-2xl font-bold py-3" />
                  </div>
                </div>
                <div className="text-center">
                  <span className="text-xs font-mono text-muted/60">Odds: </span>
                  <span className="text-sm font-mono font-bold text-accent">{fmtOdds(decOdds)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Wager */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="label mb-0">Points Wagered</p>
              <span className="font-mono font-bold text-text">{points} pts</span>
            </div>
            <input type="range" min="10" max="100" step="5" value={points}
              onChange={e => setPoints(Number(e.target.value))} disabled={isLocked}
              className="w-full accent-accent h-1 rounded-full cursor-pointer" />
            <div className="flex justify-between text-[10px] font-mono text-muted/40 mt-1.5">
              <span>10</span><span>100</span>
            </div>
          </div>

          {/* P&L preview */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-accent/8 border border-accent/20 rounded-xl px-4 py-3">
              <p className="text-[10px] text-muted/70 font-semibold uppercase tracking-wider mb-1">If correct</p>
              <p className="font-mono font-bold text-accent text-lg">+{potential}</p>
              <p className="text-[10px] font-mono text-muted/50 mt-0.5">
                {fmtOdds(decOdds)}{dbl ? ' × 2 ⚡' : ''}
              </p>
            </div>
            <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3">
              <p className="text-[10px] text-muted/70 font-semibold uppercase tracking-wider mb-1">If wrong</p>
              <p className="font-mono font-bold text-danger text-lg">−{maxLoss}</p>
              {dbl && <p className="text-[10px] font-mono text-muted/50 mt-0.5">2× loss ⚡</p>}
            </div>
          </div>

          {/* Risk badge */}
          <div className="flex items-center gap-2">
            <RiskBadge tier={riskTier} />
            <span className="text-xs text-muted">
              {riskTier === 'low' ? 'Favourite — lower reward' : riskTier === 'medium' ? 'Balanced risk/reward' : 'High risk — big upside'}
            </span>
          </div>

          {/* Double or nothing */}
          <button onClick={() => setDbl(!dbl)} disabled={isLocked || dblBlocked}
            className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all duration-150 ${
              dbl ? 'border-amber-500/40 bg-amber-500/8' : 'border-border hover:border-white/10'
            } disabled:opacity-40 disabled:cursor-not-allowed`}>
            <div className={`p-1.5 rounded-lg ${dbl ? 'bg-amber-500/20' : 'bg-surface-3'}`}>
              <Zap size={14} className={dbl ? 'text-amber-400' : 'text-muted'} />
            </div>
            <div className="text-left flex-1">
              <p className="text-sm font-semibold text-text">Double or Nothing</p>
              <p className="text-[11px] text-muted mt-0.5">
                {dblBlocked ? 'Already used this matchday' : 'Correct = 2× multiplier · Wrong = 2× loss'}
              </p>
            </div>
            <div className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${dbl ? 'bg-amber-500' : 'bg-surface-3'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${dbl ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </button>

          {error && <p className="text-danger text-sm">{error}</p>}

          <button onClick={handleSubmit} disabled={loading || isLocked} className="btn-primary w-full justify-center text-center py-3">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-bg/40 border-t-bg rounded-full animate-spin" />
                Saving…
              </span>
            ) : existing ? 'Update Prediction' : 'Lock In'}
          </button>
        </div>
      </div>
    </div>
  )
}
