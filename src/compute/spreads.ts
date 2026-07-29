import type { CurrencyRates, SpreadDirection, Spreads } from '../types/rates'

/**
 * Percentage difference of `subject` against `baseline`.
 *
 * Positive means the subject trades above the baseline — for parallel vs official,
 * a premium over the official rate, which is the naira weakening on the street.
 */
export function computeSpread(baseline: number | null, subject: number | null): number | null {
  if (baseline === null || subject === null || baseline <= 0) return null
  return Math.round(((subject - baseline) / baseline) * 100 * 100) / 100
}

/**
 * Spreads for one currency.
 *
 * Every field is independently nullable because coverage is asymmetric: CAD has no
 * official rate, CHF/JPY/DKK/SAR have no parallel one, and the stablecoin crosses
 * only exist against USD. A missing spread is reported as null rather than
 * omitted, so a caller can distinguish "no data" from "we forgot".
 */
export function computeSpreads(
  rates: CurrencyRates,
  usdt: CurrencyRates | undefined,
  usdc: CurrencyRates | undefined,
  isUsd: boolean,
): Spreads {
  const official = rates.official?.mid ?? null
  const parallel = rates.parallel?.mid ?? null

  // The stablecoin crosses are only meaningful against USD — USDT/NGN against
  // EUR official would be comparing two different things.
  const usdtMid = isUsd ? (usdt?.crypto_street?.mid ?? null) : null
  const usdcMid = isUsd ? (usdc?.crypto_street?.mid ?? null) : null

  return {
    parallel_vs_official_pct: computeSpread(official, parallel),
    usdt_vs_official_pct: computeSpread(official, usdtMid),
    usdt_vs_parallel_pct: computeSpread(parallel, usdtMid),
    usdc_vs_official_pct: computeSpread(official, usdcMid),
    usdc_vs_parallel_pct: computeSpread(parallel, usdcMid),
  }
}

/**
 * Threshold in percentage points for calling a spread compressed or widened.
 *
 * A spread is already a percentage, so this is a change in that percentage —
 * 2.4% narrowing to 2.1% is a 0.3pp compression.
 */
export const SPREAD_DIRECTION_TOLERANCE_PP = 0.2

/**
 * Direction of travel of a spread over the comparison window.
 *
 * Compressing means the parallel and official rates are converging — typically FX
 * liquidity improving. Widening means the opposite.
 */
export function computeSpreadDirection(
  spreadThen: number | null,
  spreadNow: number | null,
): SpreadDirection | null {
  if (spreadThen === null || spreadNow === null) return null

  const change = spreadNow - spreadThen
  if (change < -SPREAD_DIRECTION_TOLERANCE_PP) return 'compressing'
  if (change > SPREAD_DIRECTION_TOLERANCE_PP) return 'widening'
  return 'stable'
}
