/**
 * Monierate collector — parallel market and stablecoin street rates.
 *
 * Built on `platforms.json`, which returns every changer's own buy/sell quote for
 * a ticker and is NOT a billable feature. `latest.json`, `pairs/list`,
 * `pairs/detail` and `pairs/providers` all meter `rate_quote` (confirmed NGN 10
 * per call against a live wallet), so `platforms.json` is both the cheapest and
 * the only source of the two-sided quotes and provider counts this API sells.
 *
 * The raw platform list cannot be averaged naively. Probing all 18 candidate
 * tickers live surfaced four distinct contamination sources:
 *
 *  1. One-sided quotes encoded as `0`. Remittance corridors (remitly, sendwave,
 *     worldremit, westernunion, moneygram, ria, nala, transfergo …) publish only a
 *     send rate and report `buy: 0`. Nineteen of 65 usdngn platforms do this.
 *     Treating that 0 as a rate halves the mid — it is what produced a 1181 USD
 *     mid against a true ~1392, and a 103 DKK mid against a true ~207.
 *
 *  2. The central bank quoting inside the parallel list. `cbn` appears as a
 *     platform with the official NFEM band. Including it drags the parallel rate
 *     toward the official one and understates the parallel-vs-official spread —
 *     the single most important number this API publishes.
 *
 *  3. Reference and institutional feeds that are not street rates. `fastforex`
 *     quotes buy === sell (a mid, not a two-sided quote); `cambridge_currencies`
 *     quotes a mechanical 0.50% band around a reference mid.
 *
 *  4. Outright bad data. `monierate-fx` quoted gbpngn at 130/130 against a ~1850
 *     market — a 14x error.
 *
 * So quotes are screened, then aggregated with medians rather than means: with a
 * long tail of changers (eversend at 1462 against quidax at 1397 on the same
 * pair) a median is the honest centre, and it degrades gracefully as coverage
 * thins.
 *
 * Rate direction is normalised to bid/ask on the way in. Monierate reports
 * `buy >= sell` on every genuine two-sided quote: its `buy` is the NGN paid per
 * unit of foreign currency (the ask) and its `sell` is the NGN received (the bid).
 * CBN is oriented the opposite way — its `buyingrate` is the LOW side. Publishing
 * either upstream's own field names would give the same field opposite meanings
 * depending on source, so everything is bid/ask here, with bid <= ask throughout.
 */

import { MONIERATE_CURRENCIES, getCurrency } from '../config/currencies'
import type { MonierateCurrency } from '../config/currencies'
import type { MonieratePayload, MonierateRate, RateObservation } from '../types/rates'

const BASE = 'https://api.monierate.com/core'
const FETCH_TIMEOUT_MS = 15_000

export const MONIERATE_SOURCE = 'Monierate'

/**
 * Platforms excluded from parallel aggregates, with the reason each is not a
 * street quote. Reviewable by design — this list directly shapes the headline
 * spread, so it is data, not logic.
 */
export const REFERENCE_PLATFORMS: Readonly<Record<string, string>> = {
  // The central bank itself. Definitionally the official rate, not a street rate.
  cbn: 'central bank official rate',
  // Monierate's own reference feed; also the source of the 130/130 gbpngn error.
  'monierate-fx': "Monierate's own reference feed",
  // An FX data vendor, not a changer — quotes buy === sell.
  fastforex: 'FX data vendor, single-sided mid',
  // Institutional broker quoting a mechanical band around a reference mid.
  cambridge_currencies: 'institutional broker, synthetic 0.50% band',
}

/** A quote this many times from the median of its peers is discarded. */
export const PLATFORM_OUTLIER_RATIO = 3

/**
 * Minimum two-sided street quotes before a parallel rate is published at all.
 * One quote is still published — with `provider_count: 1` so a caller can see
 * exactly how thin it is — but zero means the market has no street price and the
 * field is null rather than invented.
 */
export const MIN_QUOTES_TO_PUBLISH = 1

interface RawPlatform {
  code?: string
  rate_mode?: string
  buy?: number | null
  sell?: number | null
  last_updated?: number | null
}

interface PlatformsEnvelope {
  status?: string
  message?: string
  data?: { ticker?: string; platforms?: RawPlatform[]; size?: number }
}

interface LatestEnvelope {
  status?: string
  message?: string
  data?: { timestamp?: number; base?: string; market?: string; rates?: number | Record<string, number> }
  /** Present on billable responses; the only way to observe the wallet balance. */
  _meta?: {
    billing?: {
      feature?: string
      units?: number
      cost?: number
      currency?: string
      wallet_balance_after?: number
    }
  }
}

/**
 * A platform quote after normalisation, in bid/ask terms. At least one side is
 * non-null.
 *
 * Note the mapping: Monierate's `buy` is the HIGH side and becomes `ask`; its
 * `sell` is the LOW side and becomes `bid`. This is the inverse of CBN, whose
 * `buyingrate` is the low side — which is exactly why both are normalised here
 * rather than stored under either upstream's own field names.
 */
interface Quote {
  code: string
  /** NGN received per unit of foreign currency — from Monierate's `sell`. */
  bid: number | null
  /** NGN paid per unit of foreign currency — from Monierate's `buy`. */
  ask: number | null
  lastUpdated: number | null
}

export interface TickerAggregate {
  ticker: string
  bid: number | null
  ask: number | null
  mid: number | null
  /** Platforms contributing a two-sided quote. */
  providerCount: number
  /** Newest platform update, unix seconds. */
  updatedAt: number | null
  fallback: boolean
  diagnostics: {
    raw: number
    reference: number
    oneSided: number
    outliers: number
    usable: number
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Round to 4dp — enough for JPY/XOF at ~2-8 NGN, and it strips float noise. */
function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000
}

/**
 * Normalise raw platforms into quotes.
 *
 * A zero or negative value means "no quote on that side", not a rate of zero.
 * Platforms with neither side are dropped entirely.
 */
export function normaliseQuotes(platforms: readonly RawPlatform[]): {
  quotes: Quote[]
  reference: number
  oneSided: number
} {
  let reference = 0
  const quotes: Quote[] = []

  for (const p of platforms) {
    const code = typeof p.code === 'string' ? p.code : ''
    if (!code) continue

    if (code in REFERENCE_PLATFORMS) {
      reference++
      continue
    }

    // Monierate buy -> ask (high side), sell -> bid (low side).
    const ask = typeof p.buy === 'number' && p.buy > 0 ? p.buy : null
    const bid = typeof p.sell === 'number' && p.sell > 0 ? p.sell : null
    if (ask === null && bid === null) continue

    quotes.push({
      code,
      bid,
      ask,
      lastUpdated: typeof p.last_updated === 'number' && p.last_updated > 0 ? p.last_updated : null,
    })
  }

  return {
    quotes,
    reference,
    oneSided: quotes.filter((q) => q.bid === null || q.ask === null).length,
  }
}

/**
 * Drop quotes far from their peers.
 *
 * Screened on whichever side each platform provides, so one-sided remittance
 * quotes are still checked. A second line of defence behind REFERENCE_PLATFORMS:
 * it independently catches the gbpngn 130 error at 14x.
 */
export function screenOutliers(quotes: readonly Quote[]): { kept: Quote[]; outliers: Quote[] } {
  const probe = quotes.map((q) => ({ q, ref: q.ask ?? q.bid! }))
  const centre = median(probe.map((p) => p.ref))

  if (centre === null || centre <= 0) return { kept: [...quotes], outliers: [] }

  const kept: Quote[] = []
  const outliers: Quote[] = []
  for (const { q, ref } of probe) {
    const ratio = Math.max(ref / centre, centre / ref)
    if (ratio > PLATFORM_OUTLIER_RATIO) outliers.push(q)
    else kept.push(q)
  }
  return { kept, outliers }
}

/** Aggregate one ticker's platform list into a single quote. */
export function aggregateTicker(ticker: string, platforms: readonly RawPlatform[]): TickerAggregate {
  const { quotes, reference, oneSided } = normaliseQuotes(platforms)
  const { kept, outliers } = screenOutliers(quotes)

  const bid = round(median(kept.map((q) => q.bid).filter((n): n is number => n !== null)))
  const ask = round(median(kept.map((q) => q.ask).filter((n): n is number => n !== null)))
  const twoSided = kept.filter((q) => q.bid !== null && q.ask !== null).length

  // Prefer a true bid/ask midpoint; fall back to whichever single side exists so a
  // pair quoted only by remittance corridors still yields something usable.
  const mid = bid !== null && ask !== null ? round((bid + ask) / 2) : (ask ?? bid)

  const updates = kept.map((q) => q.lastUpdated).filter((n): n is number => n !== null)
  const newest = updates.length > 0 ? Math.max(...updates) : null

  return {
    ticker,
    bid,
    ask,
    mid,
    providerCount: twoSided,
    // Monierate reports last_updated in epoch milliseconds.
    updatedAt: newest === null ? null : Math.floor(newest / 1000),
    fallback: false,
    diagnostics: { raw: platforms.length, reference, oneSided, outliers: outliers.length, usable: kept.length },
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function monierateFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { api_key: apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Monierate ${path} returned non-JSON (HTTP ${res.status})`)
  }

  if (!res.ok) {
    const envelope = body as { message?: string; description?: string }
    throw new Error(
      `Monierate ${path} returned HTTP ${res.status}: ${envelope.message ?? 'unknown'}` +
        (envelope.description ? ` — ${envelope.description}` : ''),
    )
  }

  return body as T
}

export async function fetchTickerPlatforms(
  ticker: string,
  apiKey: string,
): Promise<TickerAggregate> {
  const body = await monierateFetch<PlatformsEnvelope>(
    `/rates/platforms.json?ticker=${encodeURIComponent(ticker)}`,
    apiKey,
  )
  return aggregateTicker(ticker, body.data?.platforms ?? [])
}

/**
 * Billable fallback — NGN 10 per call against a prepaid wallet.
 *
 * Only returns a mid; there is no two-sided quote here. Used exclusively when
 * platforms.json yields no usable quote for a currency that should have one, and
 * capped by the caller so a systemic platforms.json outage cannot drain the
 * wallet and take the whole API down with it.
 */
export interface LatestMidResult {
  mid: number | null
  updatedAt: number
  /** Wallet balance after this charge, NGN. Null when Monierate omitted `_meta`. */
  walletNgn: number | null
}

export async function fetchLatestMid(
  currency: string,
  apiKey: string,
): Promise<LatestMidResult> {
  const body = await monierateFetch<LatestEnvelope>(
    `/rates/latest.json?base=${encodeURIComponent(currency)}&quote=NGN&market=parallel`,
    apiKey,
  )

  const rates = body.data?.rates
  const raw = typeof rates === 'number' ? rates : typeof rates === 'object' ? rates.NGN : undefined
  const mid = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? round(raw) : null

  const balance = body._meta?.billing?.wallet_balance_after

  return {
    mid,
    updatedAt: body.data?.timestamp
      ? Math.floor(body.data.timestamp / 1000)
      : Math.floor(Date.now() / 1000),
    walletNgn: typeof balance === 'number' && Number.isFinite(balance) ? balance : null,
  }
}

// ---------------------------------------------------------------------------
// Collector entry point
// ---------------------------------------------------------------------------

/**
 * Currencies eligible for the billable fallback.
 *
 * Deliberately only the well-covered pairs. CHF, JPY and DKK have zero street
 * quotes — confirmed twice over, by platforms.json returning nothing but
 * reference feeds and by latest.json answering 404 "No rates found" for DKK — so
 * a fallback call for them would spend money to learn nothing.
 */
export const FALLBACK_ELIGIBLE: ReadonlySet<string> = new Set(['USD', 'EUR', 'GBP', 'USDT', 'USDC'])

/** Hard cap on billable fallback calls per sync run. */
export const MAX_FALLBACK_CALLS = 2

/** Observed price of one `rate_quote` unit, in NGN. */
export const RATE_QUOTE_COST_NGN = 10

export interface MonierateCollectResult {
  payload: MonieratePayload
  aggregates: TickerAggregate[]
  /** Tickers that errored outright. */
  failed: { ticker: string; error: string }[]
  fallbacksUsed: number
  /** Wallet balance observed on the last billable call this run, if any. */
  walletNgn: number | null
  /** Pairs that wanted a fallback but did not get one, and why. */
  fallbacksSkipped: { currency: string; reason: string }[]
}

export interface CollectOptions {
  now?: Date
  /**
   * Whether billable fallback calls are permitted this run. The caller gates this
   * on the wallet balance so a low balance degrades coverage visibly rather than
   * silently draining the wallet and 402-ing every subsequent sync.
   */
  allowFallbacks?: boolean
}

export async function collectMonierate(
  apiKey: string,
  options: CollectOptions = {},
): Promise<MonierateCollectResult> {
  const now = options.now ?? new Date()
  const allowFallbacks = options.allowFallbacks ?? true
  const settled = await Promise.allSettled(
    MONIERATE_CURRENCIES.map(async (def) => ({
      def,
      aggregate: await fetchTickerPlatforms(def.ticker, apiKey),
    })),
  )

  const aggregates: TickerAggregate[] = []
  const failed: { ticker: string; error: string }[] = []
  const needFallback: MonierateCurrency[] = []

  settled.forEach((outcome, i) => {
    const def = MONIERATE_CURRENCIES[i]!
    if (outcome.status === 'rejected') {
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      failed.push({ ticker: def.ticker, error: message })
      if (FALLBACK_ELIGIBLE.has(def.code)) needFallback.push(def)
      return
    }

    const { aggregate } = outcome.value
    aggregates.push(aggregate)
    // A 200 with no usable quote is an outage for a pair that should have them.
    if (aggregate.providerCount < MIN_QUOTES_TO_PUBLISH && aggregate.mid === null) {
      if (FALLBACK_ELIGIBLE.has(def.code)) needFallback.push(def)
    }
  })

  let fallbacksUsed = 0
  let walletNgn: number | null = null
  const fallbacksSkipped: { currency: string; reason: string }[] = []

  const eligible = allowFallbacks ? needFallback.slice(0, MAX_FALLBACK_CALLS) : []
  for (const def of needFallback) {
    if (!eligible.includes(def)) {
      fallbacksSkipped.push({
        currency: def.code,
        reason: allowFallbacks
          ? `per-run cap of ${MAX_FALLBACK_CALLS} billable calls reached`
          : 'billable fallbacks disabled for this run (low wallet balance)',
      })
    }
  }

  for (const def of eligible) {
    try {
      const latest = await fetchLatestMid(def.code, apiKey)
      fallbacksUsed++
      if (latest.walletNgn !== null) walletNgn = latest.walletNgn
      if (latest.mid === null) continue

      const existing = aggregates.findIndex((a) => a.ticker === def.ticker)
      const replacement: TickerAggregate = {
        ticker: def.ticker,
        bid: null,
        ask: null,
        mid: latest.mid,
        providerCount: 0,
        updatedAt: latest.updatedAt,
        fallback: true,
        diagnostics: { raw: 0, reference: 0, oneSided: 0, outliers: 0, usable: 0 },
      }
      if (existing >= 0) aggregates[existing] = replacement
      else aggregates.push(replacement)
    } catch (err: unknown) {
      console.warn(`monierate: fallback for ${def.code} failed`, err)
    }
  }

  if (fallbacksSkipped.length > 0) {
    console.warn(
      `monierate: ${fallbacksSkipped.length} pair(s) left unfilled to protect the wallet — ` +
        fallbacksSkipped.map((f) => `${f.currency} (${f.reason})`).join('; '),
    )
  }

  const fetchedAt = Math.floor(now.getTime() / 1000)
  const rates: Record<string, MonierateRate> = {}

  for (const agg of aggregates) {
    const def = MONIERATE_CURRENCIES.find((c) => c.ticker === agg.ticker)
    if (!def?.monierateMarket) continue
    if (agg.mid === null) continue

    rates[def.code] = {
      market: def.monierateMarket,
      bid: agg.bid,
      ask: agg.ask,
      mid: agg.mid,
      providerCount: agg.providerCount,
      updatedAt: agg.updatedAt ?? fetchedAt,
      fallback: agg.fallback,
    }
  }

  return {
    payload: {
      fetchedAt,
      rates,
      failedTickers: [
        ...failed.map((f) => f.ticker),
        ...aggregates.filter((a) => a.mid === null).map((a) => a.ticker),
      ],
    },
    aggregates,
    failed,
    fallbacksUsed,
    walletNgn,
    fallbacksSkipped,
  }
}

/** Shape a collector result for the intraday `rate_snapshots` table. */
export function toSnapshotObservations(payload: MonieratePayload): RateObservation[] {
  const observations: RateObservation[] = []

  for (const [code, rate] of Object.entries(payload.rates)) {
    if (!getCurrency(code)) continue
    observations.push({
      currency: code,
      market: rate.market,
      bid: rate.bid,
      ask: rate.ask,
      mid: rate.mid,
      providerCount: rate.providerCount,
    })
  }

  return observations
}
