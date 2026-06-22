/**
 * Market registry barrel.
 *
 * Importing this file (or any symbol from it) registers every market.
 * Each market module's `registerMarket(...)` call happens at import time,
 * so just touching this barrel populates the registry.
 *
 * Anything in the app that needs to enumerate / price / grade markets should
 * import from here — not from individual market files or `./registry`
 * directly — so the registry is always populated before use.
 */

// Side-effect imports: each market self-registers.
import './result'
import './btts'
import './exactScore'

// Public surface: types + registry helpers.
export type {
  LegStatus,
  MarketDef,
  MarketDisplay,
  MarketParams,
  MarketType,
  MatchFacts,
  MatchPricingInputs,
  Selection,
} from './types'

export {
  enumerateAll,
  getMarket,
  gradeLeg,
  priceLeg,
  registeredMarketTypes,
} from './registry'
