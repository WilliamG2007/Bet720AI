/**
 * Floating bet-slip button + slide-up drawer.
 *
 * Rendered once at the app root. When the slip has legs, a pill at the
 * bottom of the screen shows the leg count and combined odds. Tapping
 * opens a full drawer where the user can review legs, set a stake, and
 * place the bet (single or parlay).
 */
import { useState } from 'react'
import { X, Trash2, Zap } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useLeague } from '../contexts/LeagueContext'
import { useBetSlip } from '../contexts/BetSlipContext'
import { format } from 'date-fns'

function fmtOdds(d: number) { return `×${d.toFixed(2)}` }

export function BetSlip() {
  const { authUser } = useAuth()
  const { activeLeague } = useLeague()
  const { legs, removeLeg, clearSlip, combinedOdds } = useBetSlip()

  const [open, setOpen] = useState(false)
  const [stake, setStake] = useState(25)
  const [dbl, setDbl] = useState(false)
  const [reasoning, setReasoning] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [placed, setPlaced] = useState(false)

  if (!legs.length) return null

  const isParlay = legs.length > 1
  const netMult = combinedOdds - 1
  const finalMult = !isParlay && dbl ? netMult * 2 : netMult
  const potential = Math.round(stake * finalMult)
  const maxLoss = !isParlay && dbl ? stake * 2 : stake

  async function handlePlace() {
    if (!authUser || !activeLeague) return
    setError(''); setLoading(true)
    const { error: err } = await supabase.rpc('place_bet_v2', {
      p_league_id:         activeLeague.id,
      p_legs:              legs.map(l => ({
        match_id:    l.matchId,
        market_type: l.marketType,
        params:      l.params,
        selection:   l.selection,
      })),
      p_stake:             stake,
      p_double_or_nothing: !isParlay && dbl,
      p_reasoning:         reasoning.trim() || null,
    })
    setLoading(false)
    if (err) {
      setError(err.message.replace(/^.*?:\s*/, ''))
    } else {
      setPlaced(true)
      setTimeout(() => {
        clearSlip()
        setOpen(false)
        setPlaced(false)
        setDbl(false)
        setReasoning('')
        setError('')
      }, 1800)
    }
  }

  return (
    <>
      {/* ── Floating pill ── */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5 px-5 py-2.5 rounded-full bg-accent text-bg font-bold shadow-lg text-sm animate-fade-in"
        >
          <span className="w-5 h-5 rounded-full bg-bg/20 flex items-center justify-center text-[11px] font-black">
            {legs.length}
          </span>
          Slip
          <span className="font-mono text-bg/70 text-xs">{fmtOdds(combinedOdds)}</span>
        </button>
      )}

      {/* ── Drawer overlay ── */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

          <div className="relative bg-surface rounded-t-2xl max-h-[90vh] flex flex-col animate-slide-up">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <p className="font-bold text-text text-base">
                  {isParlay ? `${legs.length}-Leg Parlay` : 'Single Bet'}
                </p>
                <p className="text-xs text-muted mt-0.5">
                  Combined odds: <span className="font-mono text-accent">{fmtOdds(combinedOdds)}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={clearSlip} className="btn-icon text-muted hover:text-danger" title="Clear slip">
                  <Trash2 size={15} />
                </button>
                <button onClick={() => setOpen(false)} className="btn-icon">
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {/* Legs */}
              <div className="space-y-2">
                {legs.map(leg => (
                  <div key={`${leg.matchId}-${leg.marketType}`}
                    className="flex items-start gap-3 bg-surface-2 rounded-xl px-3 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-muted/60 font-mono uppercase truncate">
                        {leg.matchLabel} · {format(new Date(leg.kickoffAt), 'EEE HH:mm')}
                      </p>
                      <p className="text-xs text-muted mt-0.5">{leg.marketLabel}</p>
                      <p className="text-sm font-semibold text-text mt-0.5">{leg.selectionLabel}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                      <span className="font-mono text-sm font-bold text-accent">{fmtOdds(leg.decimalOdds)}</span>
                      <button onClick={() => removeLeg(leg.matchId, leg.marketType)}
                        className="text-muted/40 hover:text-danger transition-colors">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Stake */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="label mb-0">Stake</p>
                  <span className="font-mono font-bold text-text">{stake} pts</span>
                </div>
                <input type="range" min="10" max="100" step="5" value={stake}
                  onChange={e => setStake(Number(e.target.value))}
                  className="w-full accent-accent h-1 rounded-full cursor-pointer" />
                <div className="flex justify-between text-[10px] font-mono text-muted/40 mt-1">
                  <span>10</span><span>100</span>
                </div>
              </div>

              {/* P&L */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-accent/8 border border-accent/20 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-muted/70 font-semibold uppercase tracking-wider mb-1">If all win</p>
                  <p className="font-mono font-bold text-accent text-lg">+{potential}</p>
                  <p className="text-[10px] font-mono text-muted/50 mt-0.5">{fmtOdds(combinedOdds)}{!isParlay && dbl ? ' × 2 ⚡' : ''}</p>
                </div>
                <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-muted/70 font-semibold uppercase tracking-wider mb-1">If any lose</p>
                  <p className="font-mono font-bold text-danger text-lg">−{maxLoss}</p>
                  {!isParlay && dbl && <p className="text-[10px] font-mono text-muted/50 mt-0.5">2× loss ⚡</p>}
                </div>
              </div>

              {/* Double or nothing — singles only */}
              {!isParlay && (
                <button onClick={() => setDbl(!dbl)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-150 ${
                    dbl ? 'border-amber-500/40 bg-amber-500/8' : 'border-border hover:border-white/10'
                  }`}>
                  <div className={`p-1.5 rounded-lg ${dbl ? 'bg-amber-500/20' : 'bg-surface-3'}`}>
                    <Zap size={14} className={dbl ? 'text-amber-400' : 'text-muted'} />
                  </div>
                  <div className="text-left flex-1">
                    <p className="text-sm font-semibold text-text">Double or Nothing</p>
                    <p className="text-[11px] text-muted mt-0.5">Correct = 2× · Wrong = 2× loss</p>
                  </div>
                  <div className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${dbl ? 'bg-amber-500' : 'bg-surface-3'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${dbl ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </button>
              )}

              {/* Hot take */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="label !mb-0">Hot Take <span className="text-muted/50 font-normal normal-case tracking-normal">· optional</span></p>
                  <span className="text-[10px] font-mono text-muted/50">{reasoning.length}/140</span>
                </div>
                <textarea value={reasoning} onChange={e => setReasoning(e.target.value.slice(0, 140))}
                  placeholder="Why this bet?" rows={2}
                  className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2 text-sm text-text placeholder:text-muted/40 focus:border-accent/40 focus:outline-none resize-none" />
              </div>

              {error && <p className="text-danger text-sm">{error}</p>}
            </div>

            {/* Footer CTA */}
            <div className="px-5 py-4 border-t border-border">
              <button onClick={handlePlace} disabled={loading || placed || !authUser || !activeLeague}
                className="btn-primary w-full justify-center py-3">
                {placed ? '🎉 Bet placed!' : loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-bg/40 border-t-bg rounded-full animate-spin" />
                    Placing…
                  </span>
                ) : isParlay
                  ? `Place ${legs.length}-Leg Parlay · ${stake} pts`
                  : `Place Bet · ${stake} pts`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
