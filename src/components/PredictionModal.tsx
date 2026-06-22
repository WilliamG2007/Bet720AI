import { useState, useEffect } from 'react'
import { X, Zap, PlusCircle } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useBetSlip } from '../contexts/BetSlipContext'
import type { Match, Prediction, PredictionType, RiskTier } from '../types/database'
import { TeamCrest } from './TeamCrest'
import { RiskBadge } from './RiskBadge'
import {
  exactScoreDecimalOdds,
  decimalToMultiplier,
  oddsToRiskTier,
} from '../lib/poissonOdds'
import { priceLeg } from '../lib/markets'
import type { MatchPricingInputs } from '../lib/markets'
import { clientFallbackOdds, looksLikeDefaultOdds } from '../lib/wcStrength'

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
  const { addLeg, hasLeg } = useBetSlip()
  // Live current score — drives "impossible pick" gating below
  const curHomeLive = match.status === 'live' ? (match.home_score ?? 0) : 0
  const curAwayLive = match.status === 'live' ? (match.away_score ?? 0) : 0
  const [predType, setPredType]     = useState<PredictionType>('result')
  const [resultPick, setResultPick] = useState<'1' | 'X' | '2'>('1')
  const [bttsPick, setBttsPick]     = useState<'yes' | 'no'>('yes')
  // Default exact-score to the current score so live picks aren't auto-impossible
  const [homeScore, setHomeScore]   = useState(() => String(curHomeLive || 1))
  const [awayScore, setAwayScore]   = useState(() => String(curAwayLive))
  // New market state
  const [ouLine, setOuLine]         = useState(2.5)
  const [ouPick, setOuPick]         = useState<'over' | 'under'>('over')
  const [dcPick, setDcPick]         = useState<'1X' | 'X2' | '12'>('1X')
  const [dnbPick, setDnbPick]       = useState<'1' | '2'>('1')
  const [points, setPoints]         = useState(25)
  const [dbl, setDbl]               = useState(false)
  const [reasoning, setReasoning]   = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')

  // Real odds haven't landed yet (NULL in DB) — display defaults but DON'T
  // let the user lock in a bet against them, otherwise heavy favourites
  // would pay out at the neutral 2.15/3.60 fallback.
  // A WC row stuck on the literal DEFAULT_MATCH_ODDS values gets the same
  // treatment — place_bet would settle against those defaults, which is
  // wrong for nation matchups.
  const stuckOnDefault = match.competition === 'FIFA World Cup' && looksLikeDefaultOdds(match)
  const oddsMissing = match.home_odds == null || match.away_odds == null || stuckOnDefault

  // For WC matches without DB odds (or stuck on defaults), fall back to
  // nation-strength Poisson — what the user previews here matches what
  // /api/sync/matches will write to the DB on the next sweep.
  const fb = clientFallbackOdds(match)
  const baseOdds = stuckOnDefault ? {
    home: fb.home, draw: fb.draw, away: fb.away,
    bttsYes: fb.bttsYes, bttsNo: fb.bttsNo,
    homeExp: fb.homeExpected, awayExp: fb.awayExpected,
  } : {
    home:     match.home_odds     ?? fb.home,
    draw:     match.draw_odds     ?? fb.draw,
    away:     match.away_odds     ?? fb.away,
    bttsYes:  match.btts_yes_odds ?? fb.bttsYes,
    bttsNo:   match.btts_no_odds  ?? fb.bttsNo,
    homeExp:  match.expected_home_goals ?? fb.homeExpected,
    awayExp:  match.expected_away_goals ?? fb.awayExpected,
  }

  function getParams(): Record<string, unknown> {
    if (predType === 'ou_goals') return { line: ouLine }
    return {}
  }

  function getValue(): string {
    if (predType === 'result')       return resultPick
    if (predType === 'btts')         return bttsPick
    if (predType === 'exact_score')  return `${homeScore}-${awayScore}`
    if (predType === 'ou_goals')     return ouPick
    if (predType === 'double_chance') return dcPick
    if (predType === 'draw_no_bet')  return dnbPick
    return ''
  }

  function getSelectionLabel(): string {
    if (predType === 'result')       return resultPick === '1' ? `${match.home_team} Win` : resultPick === 'X' ? 'Draw' : `${match.away_team} Win`
    if (predType === 'btts')         return bttsPick === 'yes' ? 'Both Score' : 'Clean Sheet'
    if (predType === 'exact_score')  return `${homeScore}–${awayScore}`
    if (predType === 'ou_goals')     return `${ouPick === 'over' ? 'Over' : 'Under'} ${ouLine}`
    if (predType === 'double_chance') return dcPick
    if (predType === 'draw_no_bet')  return dnbPick === '1' ? `${match.home_team} (DNB)` : `${match.away_team} (DNB)`
    return getValue()
  }

  const marketTypeForApi = predType === 'result' ? '1x2' : predType

  // Pricing inputs for the market registry (new markets)
  const pricingInputs: MatchPricingInputs = {
    status: match.status === 'live' ? 'live' : 'scheduled',
    expectedHomeGoals: baseOdds.homeExp,
    expectedAwayGoals: baseOdds.awayExp,
    homeScore: match.home_score ?? undefined,
    awayScore: match.away_score ?? undefined,
    kickoffAt: match.kickoff_at,
  }

  // Decimal odds for the currently selected pick
  function currentDecimalOdds(): number {
    if (predType === 'result') {
      return resultPick === '1' ? baseOdds.home : resultPick === 'X' ? baseOdds.draw : baseOdds.away
    }
    if (predType === 'btts') {
      return bttsPick === 'yes' ? baseOdds.bttsYes : baseOdds.bttsNo
    }
    if (predType === 'exact_score') {
      const h = parseInt(homeScore) || 0
      const a = parseInt(awayScore) || 0
      const curHome = match.status === 'live' ? (match.home_score ?? 0) : 0
      const curAway = match.status === 'live' ? (match.away_score ?? 0) : 0
      return exactScoreDecimalOdds(baseOdds.homeExp, baseOdds.awayExp, h, a, curHome, curAway)
    }
    // New markets: price via registry
    return priceLeg(pricingInputs, marketTypeForApi as Parameters<typeof priceLeg>[1], getParams(), getValue())
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

  function handleAddToSlip() {
    if (formDisabled || pickImpossible) return
    const marketLabels: Record<string, string> = {
      result: 'Match Result', btts: 'Both Teams Score', exact_score: 'Exact Score',
      ou_goals: `Goals O/U ${ouLine}`, double_chance: 'Double Chance', draw_no_bet: 'Draw No Bet',
    }
    addLeg({
      matchId: match.id,
      matchLabel: `${match.home_team} vs ${match.away_team}`,
      kickoffAt: match.kickoff_at,
      marketType: marketTypeForApi,
      marketLabel: marketLabels[predType] ?? predType,
      params: getParams(),
      selection: getValue(),
      selectionLabel: getSelectionLabel(),
      decimalOdds: decOdds,
    })
    onClose()
  }

  async function handleSubmit() {
    if (!authUser || formDisabled || pickImpossible) return
    setError(''); setLoading(true)

    // All validation + odds recomputation happens server-side in place_bet_v2.
    const { error: err } = await supabase.rpc('place_bet_v2', {
      p_league_id:         leagueId,
      p_legs:              [{ match_id: match.id, market_type: marketTypeForApi, params: getParams(), selection: getValue() }],
      p_stake:             points,
      p_double_or_nothing: dbl,
      p_reasoning:         reasoning.trim() || null,
    })

    if (err) {
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
            <p className="label">Market</p>
            <div className="flex gap-2 overflow-x-auto -mx-5 px-5 pb-1" style={{ scrollbarWidth: 'none' }}>
              {([
                { type: 'result'        as PredictionType, label: 'Result',    sub: '1/X/2' },
                { type: 'btts'          as PredictionType, label: 'BTTS',      sub: 'Yes/No' },
                { type: 'ou_goals'      as PredictionType, label: 'O/U Goals', sub: `${ouLine}` },
                { type: 'double_chance' as PredictionType, label: 'Dbl Chance',sub: '1X/X2/12' },
                { type: 'draw_no_bet'   as PredictionType, label: 'DNB',       sub: 'Draw=void' },
                { type: 'exact_score'   as PredictionType, label: 'Exact',     sub: 'Score' },
              ]).map(t => {
                const placedThisType = existingPredictions.some(p => p.prediction_type === t.type)
                const inSlip = hasLeg(match.id, t.type === 'result' ? '1x2' : t.type)
                return (
                  <button key={t.type} onClick={() => setPredType(t.type)} disabled={isLocked}
                    className={`flex-shrink-0 flex flex-col items-center px-3.5 py-2.5 rounded-xl border transition-all duration-100 ${
                      predType === t.type ? 'border-accent/40 bg-accent/5' : 'border-border hover:border-white/10'
                    }`}>
                    <p className={`text-[11px] font-bold leading-tight ${predType === t.type ? 'text-accent' : 'text-text'}`}>{t.label}</p>
                    <p className="text-[10px] text-muted/60 mt-0.5">{t.sub}</p>
                    {(placedThisType || inSlip) && (
                      <span className={`text-[8px] font-bold uppercase tracking-wider mt-1 ${inSlip ? 'text-amber-400' : 'text-accent'}`}>
                        {inSlip ? 'In slip' : 'Placed'}
                      </span>
                    )}
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

            {predType === 'ou_goals' && (
              <div className="space-y-3">
                {/* Line selector */}
                <div className="flex gap-1.5 justify-center">
                  {[0.5, 1.5, 2.5, 3.5, 4.5].map(l => (
                    <button key={l} onClick={() => setOuLine(l)} disabled={formDisabled}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold border transition-all ${
                        ouLine === l ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-muted hover:border-white/15'
                      }`}>{l}</button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['over', 'under'] as const).map(v => {
                    const d = priceLeg(pricingInputs, 'ou_goals', { line: ouLine }, v)
                    return (
                      <button key={v} onClick={() => setOuPick(v)} disabled={formDisabled}
                        className={`py-4 rounded-xl border text-center transition-all duration-100 ${
                          ouPick === v ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                        }`}>
                        <div className={`font-bold text-sm ${ouPick === v ? 'text-accent' : 'text-text'}`}>
                          {v === 'over' ? '⬆ Over' : '⬇ Under'} {ouLine}
                        </div>
                        <div className={`text-[11px] font-mono mt-1 ${ouPick === v ? 'text-accent/70' : 'text-muted/60'}`}>{fmtOdds(d)}</div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {predType === 'double_chance' && (
              <div className="space-y-2">
                {([
                  { v: '1X' as const, label: `1X · ${match.home_team} or Draw` },
                  { v: 'X2' as const, label: `X2 · Draw or ${match.away_team}` },
                  { v: '12' as const, label: `12 · ${match.home_team} or ${match.away_team}` },
                ] as const).map(({ v, label }) => {
                  const d = priceLeg(pricingInputs, 'double_chance', {}, v)
                  return (
                    <button key={v} onClick={() => setDcPick(v)} disabled={formDisabled}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-100 ${
                        dcPick === v ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                      }`}>
                      <span className={`text-sm font-semibold ${dcPick === v ? 'text-accent' : 'text-text'}`}>{label}</span>
                      <span className={`text-xs font-mono ${dcPick === v ? 'text-accent/70' : 'text-muted/60'}`}>{fmtOdds(d)}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {predType === 'draw_no_bet' && (
              <div className="space-y-2">
                <p className="text-xs text-muted/60 text-center">Draw returns your stake — only home or away wins count.</p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: '1' as const, label: match.home_team },
                    { v: '2' as const, label: match.away_team },
                  ] as const).map(({ v, label }) => {
                    const d = priceLeg(pricingInputs, 'draw_no_bet', {}, v)
                    return (
                      <button key={v} onClick={() => setDnbPick(v)} disabled={formDisabled}
                        className={`py-4 rounded-xl border text-center transition-all duration-100 ${
                          dnbPick === v ? 'border-accent/50 bg-accent/10' : 'border-border hover:border-white/15'
                        }`}>
                        <div className={`font-bold text-sm truncate px-2 ${dnbPick === v ? 'text-accent' : 'text-text'}`}>{label}</div>
                        <div className={`text-[11px] font-mono mt-1 ${dnbPick === v ? 'text-accent/70' : 'text-muted/60'}`}>{fmtOdds(d)}</div>
                      </button>
                    )
                  })}
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

          <div className="flex gap-2">
            {/* Add to slip — for building parlays across matches */}
            {!alreadyPlaced && !isLocked && !oddsMissing && !tooEarly && !pickImpossible && (
              <button onClick={handleAddToSlip}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-border hover:border-white/15 text-sm font-semibold text-text transition-colors flex-shrink-0">
                <PlusCircle size={15} />
                Slip
              </button>
            )}

            <button onClick={handleSubmit}
              disabled={loading || formDisabled || pickImpossible}
              className="btn-primary flex-1 justify-center text-center py-3">
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
    </div>
  )
}
