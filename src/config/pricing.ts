/**
 * Pricing and request bounds — the single source of truth.
 *
 * Lives in config rather than in a route because four surfaces need it: the route
 * enforces it, and `/.well-known/x402`, `/llms.txt` and `/openapi.json` all
 * advertise it. Anything hardcoded elsewhere is a drift bug.
 */

/**
 * Maximum `days` accepted by /v1/rates/history.
 *
 * 365, not 30. The original 30 was chosen when there was no parallel history at
 * all; after backfilling, USDT reaches back 956 days and USD 719, and a 30-day cap
 * made ~96% of that unreachable at any price. A year is a natural ceiling and
 * keeps a response bounded at ~365 rows.
 */
export const MAX_DAYS = 365

export const DEFAULT_DAYS = 7

/**
 * Settlement tiers for /v1/rates/history, charged by the size of the window.
 *
 * The route advertises `upto` at PRICE_HISTORY (the cap) and then declares the
 * actual amount at settlement, so a caller asking for a week is not charged for a
 * year. `amount` is in the asset's base units — USDC has 6 decimals, so "10000" is
 * $0.01.
 *
 * IMPORTANT: partial settlement only exists in the `upto` scheme. A client that
 * chooses `exact` from `accepts` settles the full advertised cap regardless of
 * `days`, because `exact` has no notion of settling less than it authorised. That
 * is a client-side choice, and it is documented on every surface that quotes the
 * price so nobody is surprised after paying.
 *
 * Tiers are ordered ascending and the last entry must cover MAX_DAYS.
 */
export interface HistoryTier {
  /** Inclusive upper bound on `days` for this tier. */
  maxDays: number
  /** Settlement amount in asset base units. */
  amount: string
  /** Human-readable equivalent, for documentation. */
  usd: string
}

export const HISTORY_TIERS: readonly HistoryTier[] = [
  { maxDays: 7, amount: '10000', usd: '$0.01' },
  { maxDays: 30, amount: '20000', usd: '$0.02' },
  { maxDays: 90, amount: '30000', usd: '$0.03' },
  { maxDays: 365, amount: '50000', usd: '$0.05' },
] as const

/**
 * The tier a request falls into.
 *
 * Falls back to the last (most expensive) tier rather than throwing, so a future
 * MAX_DAYS increase without a matching tier over-charges the operator's own
 * ceiling instead of under-charging or erroring mid-request.
 */
export function settlementTierForDays(days: number): HistoryTier {
  return HISTORY_TIERS.find((t) => days <= t.maxDays) ?? HISTORY_TIERS[HISTORY_TIERS.length - 1]!
}

/** Human-readable tier table, e.g. "1-7d $0.01, 8-30d $0.02, …". */
export function describeHistoryTiers(): string {
  let lower = 1
  const parts = HISTORY_TIERS.map((t) => {
    const label = `${lower}-${t.maxDays}d ${t.usd}`
    lower = t.maxDays + 1
    return label
  })
  return parts.join(', ')
}
