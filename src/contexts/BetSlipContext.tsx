/**
 * Global bet-slip state. Persists selected legs as the user navigates
 * between match pages, then submits them as a single place_bet_v2 call
 * (parlay if N > 1, single if N = 1).
 */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface SlipLeg {
  matchId: string
  matchLabel: string   // "Brazil vs Argentina"
  kickoffAt: string
  marketType: string   // '1x2', 'ou_goals', etc. — in place_bet_v2 format
  marketLabel: string  // "Match Result", "Goals O/U 2.5"
  params: Record<string, unknown>
  selection: string    // '1', 'over', 'yes', '2-1', etc.
  selectionLabel: string // "Home Win", "Over 2.5"
  decimalOdds: number
}

interface BetSlipCtx {
  legs: SlipLeg[]
  addLeg: (leg: SlipLeg) => void
  removeLeg: (matchId: string, marketType: string) => void
  clearSlip: () => void
  hasLeg: (matchId: string, marketType: string) => boolean
  combinedOdds: number
}

const Ctx = createContext<BetSlipCtx | null>(null)

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [legs, setLegs] = useState<SlipLeg[]>([])

  const addLeg = useCallback((leg: SlipLeg) => {
    setLegs(prev => {
      // Replace if same match + market type already in slip
      const without = prev.filter(l => !(l.matchId === leg.matchId && l.marketType === leg.marketType))
      return [...without, leg]
    })
  }, [])

  const removeLeg = useCallback((matchId: string, marketType: string) => {
    setLegs(prev => prev.filter(l => !(l.matchId === matchId && l.marketType === marketType)))
  }, [])

  const clearSlip = useCallback(() => setLegs([]), [])

  const hasLeg = useCallback(
    (matchId: string, marketType: string) =>
      legs.some(l => l.matchId === matchId && l.marketType === marketType),
    [legs],
  )

  const combinedOdds = legs.reduce((acc, l) => acc * l.decimalOdds, 1)

  return (
    <Ctx.Provider value={{ legs, addLeg, removeLeg, clearSlip, hasLeg, combinedOdds }}>
      {children}
    </Ctx.Provider>
  )
}

export function useBetSlip(): BetSlipCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useBetSlip must be used inside BetSlipProvider')
  return ctx
}
