/**
 * Central market registry. Markets register themselves at import time via
 * `registerMarket(...)`; the rest of the app talks to the registry, never
 * to specific markets, so adding a new bet kind is one file in this folder.
 *
 * The barrel `./index.ts` imports every market module for its side-effect
 * of registering, then re-exports the registry helpers. Anything that needs
 * to enumerate / price / grade markets should import from `./index`, not
 * from this file directly.
 */

import type {
  MarketDef,
  MarketDisplay,
  MarketParams,
  MarketType,
  MatchFacts,
  MatchPricingInputs,
  LegStatus,
} from './types'

const registry = new Map<MarketType, MarketDef>()

/**
 * Register a market. Throws on duplicate registration so we catch accidental
 * double-imports during dev.
 */
export function registerMarket<P extends MarketParams>(def: MarketDef<P>): void {
  if (registry.has(def.type)) {
    throw new Error(`market type already registered: ${def.type}`)
  }
  registry.set(def.type, def as MarketDef)
}

/** Look up a market by type. Throws when unknown — bets should never reach
 * here with an unregistered type, but a clear error beats a silent NaN. */
export function getMarket(type: MarketType): MarketDef {
  const def = registry.get(type)
  if (!def) throw new Error(`unknown market type: ${type}`)
  return def
}

/** Every registered market type. */
export function registeredMarketTypes(): MarketType[] {
  return [...registry.keys()]
}

/**
 * Build the full catalog of bettable groups for a match (every registered
 * market's `enumerate` output, flattened). Markets can return empty lists
 * — e.g. a live-only market for a scheduled match — and those are skipped.
 */
export function enumerateAll(match: MatchPricingInputs): MarketDisplay[] {
  const out: MarketDisplay[] = []
  for (const def of registry.values()) {
    out.push(...def.enumerate(match))
  }
  return out
}

/** Decimal odds for one (market_type, params, selection). */
export function priceLeg(
  match: MatchPricingInputs,
  type: MarketType,
  params: MarketParams,
  selection: string,
): number {
  return getMarket(type).price(match, params, selection)
}

/** Grade a leg against final-match facts. */
export function gradeLeg(
  facts: MatchFacts,
  type: MarketType,
  params: MarketParams,
  selection: string,
): LegStatus {
  return getMarket(type).grade(facts, params, selection)
}
