import { useState, useEffect } from 'react'
import { X, Zap } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import type { Match, Prediction, PredictionType, RiskTier } from '../types/database'
import { TeamCrest } from './TeamCrest'
import { RiskBadge } from './RiskBadge'
import {
  exactScoreDecimalOdds,
  decimalToMultiplier,
  oddsToRiskTier,
} from '../lib/poissonOdds'
import { clientFallbackOdds } from '../lib/wcStrength'

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
  // Live current score — drives "impossible pick" gating below
  const curHomeLive = match.status === 'live' ? (match.home_score ?? 0) : 0
  const curAwayLive = match.status === 'live' ? (match.away_score ?? 0) : 0
  const [predType, setPredType]     = useState<PredictionType>('result')
  const [resultPick, setResultPick] = useState<'1' | 'X' | '2'>('1')
  const [bttsPick, setBttsPick]     = useState<'yes' | 'no'>('yes')
  // Default exact-score to the current score so live picks aren't auto-impossible
  const [homeScore, setHomeScore]   = useState(() => String(curHomeLive || 1))
  const [awayScore, setAwayScore]   = useState(() => String(curAwayLive))
  const [points, setPoints]         = useState(25)
  const [dbl, setDbl]               = useState(false)
  const [reasoning, setReasoning]   = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  // Real odds haven't landed yet (NULL in DB) — display defaults but DON'T
  // let the user lock in a bet against them, otherwise heavy favourites
  // would pay out at the neutral 2.15/3.60 fallback.
  const oddsMissing = match.home_odds == null || match.away_odds == null

  // For WC matches without DB odds, fall back to nation-strength Poisson.
  // The same function runs server-side in /api/sync/matches, so place_bet
  // will settle against the same numbers the user sees here.
  const fb = clientFallbackOdds(match)
  const baseOdds = {
    home:     match.home_odds     ?? fb.home,
    draw:     match.draw_odds     ?? fb.draw,
    away:     match.away_odds     ?? fb.away,
    bttsYes:  match.btts_yes_odds ?? fb.bttsYes,
    bttsNo:   match.btts_no_odds  ?? fb.bttsNo,
    homeExp:  match.expected_home_goals ?? fb.homeExpected,
    awayExp:  match.expected_away_goals ?? fb.awayExpected,
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
  let   netMult    = decimalToMultiplier(decOdds)            // profit multiplier (decimal - 1)

  // Early-bird tier: 24h–3h before kickoff pays out 0.75x to compensate
  // for the user betting before late info (lineups, injuries) is known.
  // Mirrors the EARLY_BIRD_FACTOR in place_bet so the previewed potential
  // matches what the server will actually pay.
  const kickoffMs    = new Date(match.kickoff_at).getTime()
  const msToKickoff  = kickoffMs - Date.now()
  const STANDARD_MS  = 3 * 60 * 60 * 1000
  const EARLY_BIRD_MS = 24 * 60 * 60 * 1000
  const isEarlyBird  = msToKickoff > STANDARD_MS && msToKickoff <= EARLY_BIRD_MS
  if (isEarlyBird) netMult = Math.max(0.1, Math.round(netMult * 0.75 * 100) / 100)

  const finalMult  = dbl ? netMult * 2 : netMult
  const riskTier: RiskTier = oddsToRiskTier(netMult)

  const potential  = Math.round(points * finalMult)
  const maxLoss    = dbl ? points * 2 : points

  // Live matches are no longer bettable for points — pre-match only.
  // (Free in-play "power-up" predictions are planned as a separate flow.)
  // Finished/postponed lock for the same reason as before.
  const isLive     = match.status === 'live'
  const isLocked   = match.status === 'finished' || match.status === 'postponed' || match.status === 'live'
  const existing   = existingPredictions.find(p => p.prediction_type === predType)
  // Bets are one-shot: once placed, that prediction type is read-only.
  const alreadyPlaced = !!existing

  // Bet window opens at 24h before kickoff. Anything in the 24h–3h band
  // pays out at 0.75x (early-bird tier, handled above). msToKickoff /
  // kickoffMs are declared earlier for the multiplier calc.
  const tooEarly    = !isLive && !isLocked && msToKickoff > EARLY_BIRD_MS

  // Impossible-pick gating for live matches.
  //  - BTTS "No"   → impossible once both teams have scored.
  //  - Exact score → can't pick a score lower than what's already on the board.
  const bttsNoImpossible = isLive && curHomeLive > 0 && curAwayLive > 0
  const exactImpossible  = predType === 'exact_score' && (
    (parseInt(homeScore) || 0) < curHomeLive ||
    (parseInt(awayScore) || 0) < curAwayLive
  )
  const pickImpossible = exactImpossible ||
    (predType === 'btts' && bttsPick === 'no' && bttsNoImpossible)

  // Snap BTTS pick away from "No" if it just became impossible
  useEffect(() => {
    if (bttsNoImpossible && bttsPick === 'no') setBttsPick('yes')
  }, [bttsNoImpossible, bttsPick])

  const formDisabled = isLocked || alreadyPlaced || oddsMissing || tooEarly

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
    setReasoning(existing.reasoning ?? '')
  }, [predType])

  async function handleSubmit() {
    if (!authUser || formDisabled || pickImpossible) return
    setError(''); setLoading(true)

    // All validation + odds_multiplier recomputation happens server-side
    // in the place_bet RPC. The client values for riskTier/odds_multiplier
    // are no longer trusted — the RPC overwrites them with the real ones
    // computed from the matches row.
    const { error: err } = await supabase.rpc('place_bet', {
      p_match_id:         match.id,
      p_league_id:        leagueId,
      p_prediction_type:  predType,
      p_predicted_value:  getValue(),
      p_points_wagered:   points,
      p_double_or_nothing: dbl,
      p_reasoning:        reasoning.trim() || null,
    })

    if (err) {
      // Surface the postgres RAISE messages verbatim — they're
      // user-readable ("bets open 180 min before kickoff", "matchday budget
      // exceeded", "BTTS No is impossible — both teams have scored", …).
      setError(err.message.replace(/^.*?:\s*/, ''))
    } else {
      onSuccess()
    }
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

          {alreadyPlaced && !isLocked && (
            <div className="bg-accent/8 border border-accent/25 rounded-xl px-4 py-3">
              <p className="text-accent text-sm font-semibold">Bet locked in · {existing.predicted_value}</p>
              <p className="text-[11px] text-muted mt-0.5">
                {existing.points_wagered} pts wagered · bets are final. Pick a different prediction type to add another.
              </p>
            </div>
          )}

          {tooEarly && (
            <div className="bg-surface-2 border border-border rounded-xl px-4 py-3 flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-muted/60 flex-shrink-0" />
              <div>
                <p className="text-text text-sm font-semibold">Bets open 24h before kickoff</p>
                <p className="text-[11px] text-muted mt-0.5">
                  Opens {format(new Date(kickoffMs - EARLY_BIRD_MS), 'EEE HH:mm')} · kickoff in {formatDistanceToNowStrict(new Date(kickoffMs))}
                </p>
              </div>
            </div>
          )}

          {isEarlyBird && !isLocked && (
            <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <span className="text-lg flex-shrink-0">🐦</span>
              <div>
                <p className="text-amber-400 text-sm font-semibold">Early Bird · payout × 0.75</p>
                <p className="text-[11px] text-muted mt-0.5">
                  Bet now or wait for lineups within 3h of kickoff for full payout · kickoff in {formatDistanceToNowStrict(new Date(kickoffMs))}
                </p>
              </div>
            </div>
          )}

          {oddsMissing && !isLocked && !tooEarly && (
            <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
              <div>
                <p className="text-amber-400 text-sm font-semibold">Loading odds…</p>
                <p className="text-[11px] text-muted mt-0.5">Fetching real odds for this match. Hold tight — bets will open as soon as they land.</p>
              </div>
            </div>
          )}

          {isLive && (
            <div className="bg-danger/8 border border-danger/25 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-danger animate-pulse flex-shrink-0" />
              <div>
                <p className="text-danger text-sm font-semibold">Live · {match.home_score ?? 0}–{match.away_score ?? 0} · bets closed</p>
                <p className="text-[11px] text-muted mt-0.5">Points bets are pre-match only. In-play power-ups are coming.</p>
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
              ]).map(t => {
                const placedThisType = existingPredictions.some(p => p.prediction_type === t.type)
                return (
                  <button key={t.type} onClick={() => setPredType(t.type)} disabled={isLocked}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-100 ${
                      predType === t.type ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-white/10'
                    }`}>
                    <div className="text-left">
                      <p className="text-sm font-semibold text-text flex items-center gap-2">
                        {t.label}
                        {placedThisType && <span className="text-[9px] font-bold uppercase tracking-wider text-accent">Placed</span>}
                      </p>
                      <p className="text-xs text-muted mt-0.5">{t.sub}</p>
                    </div>
                    <span className="text-xs font-mono text-muted/60 ml-3">{t.oddsRange}</span>
                  </button>
                )
              })}
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
                    <button key={v} onClick={() => setResultPick(v)} disabled={formDisabled}
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
                  const impossible = v === 'no' && bttsNoImpossible
                  return (
                    <button key={v} onClick={() => setBttsPick(v)} disabled={formDisabled || impossible}
                      className={`py-4 rounded-xl border text-center transition-all duration-100 ${
                        selected ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                      } ${impossible ? 'opacity-40 cursor-not-allowed line-through' : ''}`}>
                      <div className={`font-bold text-sm ${selected ? 'text-accent' : 'text-text'}`}>
                        {v === 'yes' ? '⚽ Yes' : '🧤 No'}
                      </div>
                      <div className={`text-[11px] font-mono mt-1 ${selected ? 'text-accent/70' : 'text-muted/60'}`}>
                        {impossible ? 'impossible' : fmtOdds(d)}
                      </div>
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
                    <input type="number" min={curHomeLive} max="20" value={homeScore}
                      onChange={e => setHomeScore(e.target.value)} disabled={formDisabled}
                      className="input w-20 text-center font-mono text-2xl font-bold py-3" />
                  </div>
                  <div className="text-3xl font-mono text-muted/40 pb-2">–</div>
                  <div className="text-center">
                    <p className="text-[10px] text-muted font-semibold uppercase tracking-wider mb-2">{match.away_team}</p>
                    <input type="number" min={curAwayLive} max="20" value={awayScore}
                      onChange={e => setAwayScore(e.target.value)} disabled={formDisabled}
                      className="input w-20 text-center font-mono text-2xl font-bold py-3" />
                  </div>
                </div>
                {isLive && (
                  <p className="text-center text-[11px] text-muted/60">
                    Live score is {curHomeLive}–{curAwayLive} — picks below this are impossible.
                  </p>
                )}
                {exactImpossible && (
                  <p className="text-center text-[11px] text-danger font-semibold">
                    Can't pick a final score below the current one.
                  </p>
                )}
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
              onChange={e => setPoints(Number(e.target.value))} disabled={formDisabled}
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
          <button onClick={() => setDbl(!dbl)} disabled={formDisabled || dblBlocked}
            className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all duration-150 ${
              dbl ? 'border-amber-500/40 bg-amber-500/8' : 'border-border hover:border-white/10'
            } disabled:opacity-40 disabled:cursor-not-allowed`}>
            <div className={`p-1.5 rounded-lg ${dbl ? 'bg-amber-500/20' : 'bg-surface-3'}`}>
              <Zap size={14} className={dbl ? 'text-amber-400' : 'text-muted'} />
            </div>
            <div className="text-left flex-1">
              <p className="text-sm font-semibold text-text">Double or Nothing</p>
              <p className="text-[11px] text-muted mt-0.5">
                {dblBlocked ? 'Already used today' : 'Correct = 2× multiplier · Wrong = 2× loss'}
              </p>
            </div>
            <div className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${dbl ? 'bg-amber-500' : 'bg-surface-3'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${dbl ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </button>

          {/* Hot take — optional 140-char rationale shown in feed */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="label !mb-0">Hot Take <span className="text-muted/50 font-normal normal-case tracking-normal">· optional</span></p>
              <span className="text-[10px] font-mono text-muted/50">{reasoning.length}/140</span>
            </div>
            <textarea
              value={reasoning}
              onChange={e => setReasoning(e.target.value.slice(0, 140))}
              disabled={formDisabled}
              placeholder="Why this pick? (shown in the feed)"
              rows={2}
              className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2 text-sm text-text placeholder:text-muted/40 focus:border-accent/40 focus:outline-none disabled:opacity-40 resize-none"
            />
          </div>

          {error && <p className="text-danger text-sm">{error}</p>}

          <button onClick={handleSubmit}
            disabled={loading || formDisabled || pickImpossible}
            className="btn-primary w-full justify-center text-center py-3">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-bg/40 border-t-bg rounded-full animate-spin" />
                Saving…
              </span>
            ) : alreadyPlaced
              ? 'Bet locked in'
              : isLive
                ? 'Bets closed — match is live'
                : match.status === 'finished' || match.status === 'postponed'
                  ? 'Match is over'
                  : tooEarly
                    ? 'Bets open 24h before kickoff'
                    : oddsMissing
                      ? 'Loading odds…'
                      : pickImpossible
                        ? 'Pick is impossible'
                        : 'Lock In'}
          </button>
        </div>
      </div>
    </div>
  )
}
