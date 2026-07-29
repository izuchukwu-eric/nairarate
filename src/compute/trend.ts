import type { DailySeriesRow } from '../cache/d1'
import type { TrendDirection } from '../types/rates'

/**
 * Threshold for calling a rate move directional rather than noise.
 * ±0.5% over the window.
 */
export const TREND_TOLERANCE_PCT = 0.5

export interface TrendSummary {
  direction: TrendDirection | null
  changePct: number | null
  high: number | null
  low: number | null
  /** Days with data. Below 2 no direction can be computed. */
  points: number
}

/**
 * Summarise a daily series.
 *
 * Direction is from the naira's point of view, which is the inverse of the rate:
 * a rising NGN-per-USD number means the naira is weakening, so that is
 * `depreciating`. This is the convention callers care about — they are pricing
 * naira exposure, not dollar exposure.
 *
 * Returns nulls rather than guessing when the series is too short. During the
 * first week after deploy the parallel series genuinely has too few days for a
 * 7-day trend, and saying so beats extrapolating from two points.
 */
export function summariseTrend(rows: readonly DailySeriesRow[]): TrendSummary {
  const mids = rows
    .map((r) => r.mid)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)

  if (mids.length === 0) {
    return { direction: null, changePct: null, high: null, low: null, points: 0 }
  }

  const high = Math.max(...mids)
  const low = Math.min(...mids)

  if (mids.length < 2) {
    return { direction: null, changePct: null, high, low, points: mids.length }
  }

  // Rows arrive ascending by date, so these are the window's ends.
  const first = mids[0]!
  const last = mids[mids.length - 1]!
  const changePct = Math.round(((last - first) / first) * 100 * 100) / 100

  let direction: TrendDirection
  if (changePct > TREND_TOLERANCE_PCT) direction = 'depreciating'
  else if (changePct < -TREND_TOLERANCE_PCT) direction = 'appreciating'
  else direction = 'stable'

  return {
    direction,
    changePct,
    high: Math.round(high * 10_000) / 10_000,
    low: Math.round(low * 10_000) / 10_000,
    points: mids.length,
  }
}

/**
 * The spread implied by two series on their earliest shared date, used as the
 * "then" value for spread direction.
 *
 * Matching on date rather than array position matters: the official series skips
 * weekends while the parallel series does not, so index 0 of each can be days
 * apart and would silently compare mismatched dates.
 */
export function earliestSharedSpread(
  official: readonly DailySeriesRow[],
  parallel: readonly DailySeriesRow[],
): number | null {
  const officialByDate = new Map(
    official.filter((r) => r.mid !== null && r.mid > 0).map((r) => [r.rate_date, r.mid!]),
  )

  for (const row of parallel) {
    if (row.mid === null || row.mid <= 0) continue
    const officialMid = officialByDate.get(row.rate_date)
    if (officialMid === undefined) continue
    return Math.round(((row.mid - officialMid) / officialMid) * 100 * 100) / 100
  }

  return null
}
