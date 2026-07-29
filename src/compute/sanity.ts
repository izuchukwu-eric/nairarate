/**
 * Upstream data-quality guards.
 *
 * CBN's published history contains genuine data-entry errors — DKK at 198,024 on
 * 2008-11-14 against a ~200 baseline, GBP and XOF spikes in the early 2000s,
 * isolated bad days for ZAR, CNY and JPY in recent years. Ingesting these
 * silently would corrupt the `high`, `low` and `change_pct` fields on
 * /v1/rates/history, which callers pay for.
 *
 * A global threshold cannot catch them: the naira has genuinely gone from ~₦130/$
 * in 2001 to ~₦1360/$ today, so a tenfold move is normal *across the series*. The
 * discriminator is locality — real devaluation is gradual, so a value that is
 * multiples away from its immediate neighbours is an error, not a market event.
 */

/**
 * A value this many times away from its local median is treated as an error.
 *
 * Calibrated for CBN's published history, whose errors are decimal slips — a
 * Danish krone at 198,024 against a ~200 baseline, i.e. ~1000x. 5x clears those
 * comfortably without touching genuine devaluation.
 */
export const OUTLIER_RATIO = 5

/**
 * Tighter threshold for daily FX candle series.
 *
 * Measured against the full 4,251-row Monierate backfill: the largest *genuine*
 * deviation from a local median anywhere in it is 1.13x, while the bad rows sit at
 * 3.17x — three currencies all dated 2025-10-01, an upstream incident. So the two
 * populations are cleanly separated and 5x was too loose to catch them.
 *
 * 2.5x is the chosen middle: above the ~1.63x single-day jump of the June 2023
 * naira float (the sharpest real move on record, and a plausible repeat), and well
 * below the observed bad data.
 */
export const DAILY_OUTLIER_RATIO = 2.5

/** Rows either side of a point that form its comparison window. */
const WINDOW_RADIUS = 5

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export interface SeriesPoint {
  currency: string
  rateDate: string
  mid: number
}

export interface OutlierReport<T> {
  kept: T[]
  rejected: { row: T; localMedian: number; ratio: number }[]
}

/**
 * Split a set of daily rows into plausible and implausible.
 *
 * Each row is compared against the median of its `WINDOW_RADIUS` neighbours on
 * either side within the same currency, excluding itself. Rows in series too
 * short to form a window are kept — with nothing to compare against, rejecting
 * would be a guess.
 */
export function rejectOutliers<T extends SeriesPoint>(
  rows: readonly T[],
  ratio: number = OUTLIER_RATIO,
): OutlierReport<T> {
  const byCurrency = new Map<string, T[]>()
  for (const row of rows) {
    const list = byCurrency.get(row.currency)
    if (list) list.push(row)
    else byCurrency.set(row.currency, [row])
  }

  const kept: T[] = []
  const rejected: OutlierReport<T>['rejected'] = []

  for (const series of byCurrency.values()) {
    series.sort((a, b) => a.rateDate.localeCompare(b.rateDate))

    for (let i = 0; i < series.length; i++) {
      const row = series[i]!
      const neighbours: number[] = []

      for (let j = Math.max(0, i - WINDOW_RADIUS); j <= Math.min(series.length - 1, i + WINDOW_RADIUS); j++) {
        if (j !== i) neighbours.push(series[j]!.mid)
      }

      const local = median(neighbours)
      if (local === null || local <= 0 || row.mid <= 0) {
        kept.push(row)
        continue
      }

      const deviation = row.mid > local ? row.mid / local : local / row.mid
      if (deviation > ratio) rejected.push({ row, localMedian: local, ratio: deviation })
      else kept.push(row)
    }
  }

  return { kept, rejected }
}

/**
 * Guard a single incoming value against the last known good one, for the cron —
 * where there is no future context to build a window from.
 *
 * Returns true when the value is plausible. A missing or non-positive reference
 * means we have nothing to judge against, so the value is accepted.
 */
export function isPlausibleAgainst(value: number, reference: number | null): boolean {
  if (reference === null || reference <= 0 || value <= 0) return true
  const ratio = value > reference ? value / reference : reference / value
  return ratio <= OUTLIER_RATIO
}

/** A bid or ask further than this fraction from mid is treated as corrupt. */
export const BAND_TOLERANCE = 0.2

export interface BandRepair {
  bid: number | null
  ask: number | null
  /** Sides dropped as incoherent, for logging. */
  dropped: ('bid' | 'ask')[]
}

/**
 * Reconcile a two-sided band against its mid.
 *
 * CBN publishes 31 rows where `buyingrate > sellingrate`, which is incoherent —
 * JPY on 2016-11-01 carries a bid of 29009 against a mid of 2.9057, a misplaced
 * decimal point. In every case the mid is sound: it is CBN's own published
 * central/NFEM rate, while the band around it is derived. So mid is treated as
 * authoritative and only the offending side is discarded — the row keeps its
 * value instead of being thrown away wholesale.
 *
 * Two passes, because neither alone is sufficient: a proportional check catches
 * gross errors but misses a 15% deviation, while `bid > ask` catches incoherent
 * pairs whose individual values both look reasonable.
 */
export function repairBand(
  bid: number | null,
  ask: number | null,
  mid: number | null,
): BandRepair {
  const dropped: ('bid' | 'ask')[] = []
  let outBid = bid
  let outAsk = ask

  if (mid === null || mid <= 0) return { bid: outBid, ask: outAsk, dropped }

  const deviation = (v: number): number => Math.abs(v / mid - 1)

  // Pass 1 — drop any side implausibly far from the authoritative mid.
  if (outBid !== null && (outBid <= 0 || deviation(outBid) > BAND_TOLERANCE)) {
    outBid = null
    dropped.push('bid')
  }
  if (outAsk !== null && (outAsk <= 0 || deviation(outAsk) > BAND_TOLERANCE)) {
    outAsk = null
    dropped.push('ask')
  }

  // Pass 2 — an inverted band that survived pass 1. Keep the side closer to mid;
  // never reorder them, which would invent a quote that was never published.
  if (outBid !== null && outAsk !== null && outBid > outAsk) {
    if (deviation(outBid) > deviation(outAsk)) {
      outBid = null
      dropped.push('bid')
    } else {
      outAsk = null
      dropped.push('ask')
    }
  }

  return { bid: outBid, ask: outAsk, dropped }
}
