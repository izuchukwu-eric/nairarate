import { getDailySeries } from '../cache/d1'
import { getCbnPayload, getMonieratePayload, getSourceStatus, putCachedRates } from '../cache/kv'
import { CBN_OFFICIAL_SOURCE } from '../collectors/cbn'
import { computeSpreadDirection, computeSpreads } from '../compute/spreads'
import { ageMinutes, computeConfidence, isCbnCurrent } from '../compute/confidence'
import { earliestSharedSpread, summariseTrend } from '../compute/trend'
import { CURRENCIES } from '../config/currencies'
import type {
  CurrencyRates,
  Env,
  MarketQuote,
  OfficialQuote,
  RatesResponse,
  Spreads,
  TrendBlock,
} from '../types/rates'

const TREND_WINDOW_DAYS = 7

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function parallelSourceLabel(providerCount: number, fallback: boolean): string {
  if (fallback) return 'Monierate composite index (fallback)'
  if (providerCount === 1) return 'Monierate (1 provider)'
  return `Monierate (${providerCount} providers, median)`
}

/**
 * Rebuild the served `/v1/rates` payload and write it to KV.
 *
 * Called at the end of both cron jobs rather than on the request path. This is
 * what keeps `/v1/rates` to a single KV read: spreads, 7-day trends and the
 * confidence score are all computed here, including the D1 queries the trends
 * need, so a paying request never touches D1 or an upstream.
 */
export async function rebuildRatesPayload(env: Env, now: Date = new Date()): Promise<void> {
  const [cbn, monierate, cbnStatus, monierateStatus] = await Promise.all([
    getCbnPayload(env),
    getMonieratePayload(env),
    getSourceStatus(env, 'cbn'),
    getSourceStatus(env, 'monierate'),
  ])

  const rates: Record<string, CurrencyRates> = {}

  for (const def of CURRENCIES) {
    // XAF borrows XOF's unified CFA official series; everything else uses its own.
    const officialCode = def.officialFrom ?? def.code
    const officialRate = cbn?.rates[officialCode]
    const monierateRate = monierate?.rates[def.code]

    let official: OfficialQuote | null = null
    if (officialRate && cbn) {
      official = {
        bid: officialRate.bid,
        ask: officialRate.ask,
        mid: officialRate.mid,
        source: CBN_OFFICIAL_SOURCE,
        // This currency's own business date, which may lag the payload's newest.
        updated_at: `${officialRate.rateDate}T00:00:00Z`,
        high: officialRate.high ?? null,
        low: officialRate.low ?? null,
        close: officialRate.close ?? null,
        turnover: officialRate.turnover ?? null,
        deal_count: officialRate.dealCount ?? null,
      }
    }

    let quote: MarketQuote | null = null
    if (monierateRate) {
      quote = {
        bid: monierateRate.bid,
        ask: monierateRate.ask,
        mid: monierateRate.mid,
        provider_count: monierateRate.providerCount,
        source: parallelSourceLabel(monierateRate.providerCount, monierateRate.fallback),
        updated_at: iso(monierateRate.updatedAt),
      }
    }

    const entry: CurrencyRates = {
      official,
      parallel: monierateRate?.market === 'parallel' ? quote : null,
      crypto_street: monierateRate?.market === 'crypto_street' ? quote : null,
    }
    if (def.note) entry.note = def.note

    rates[def.code] = entry
  }

  // Spreads — computed for every currency; individual fields null where a market
  // is absent.
  const spreads: Record<string, Spreads> = {}
  for (const def of CURRENCIES) {
    spreads[def.code] = computeSpreads(
      rates[def.code]!,
      rates.USDT,
      rates.USDC,
      def.code === 'USD',
    )
  }

  // Trends — the only D1 access in the whole pipeline, and it happens here in the
  // cron rather than on a paid request.
  const trend7d: Record<string, TrendBlock> = {}
  for (const def of CURRENCIES) {
    const parallelMarket = def.monierateMarket
    const [officialSeries, parallelSeries] = await Promise.all([
      def.cbnOfficial
        ? getDailySeries(env, def.officialFrom ?? def.code, 'official', TREND_WINDOW_DAYS)
        : Promise.resolve([]),
      parallelMarket
        ? getDailySeries(env, def.code, parallelMarket, TREND_WINDOW_DAYS)
        : Promise.resolve([]),
    ])

    const officialTrend = summariseTrend(officialSeries)
    const parallelTrend = summariseTrend(parallelSeries)

    trend7d[def.code] = {
      parallel_direction: parallelTrend.direction,
      official_direction: officialTrend.direction,
      spread_direction: computeSpreadDirection(
        earliestSharedSpread(officialSeries, parallelSeries),
        spreads[def.code]?.parallel_vs_official_pct ?? null,
      ),
    }
  }

  const monierateAge = ageMinutes(monierate ? iso(monierate.fetchedAt) : null, now)
  const { confidence, warnings } = computeConfidence({
    monierateAgeMinutes: monierateAge,
    cbnCurrent: isCbnCurrent(cbnStatus.lastOk, now),
    monierateErrored: monierateStatus.lastError !== null,
    cbnErrored: cbnStatus.lastError !== null,
    failedTickers: monierate?.failedTickers,
  })

  // Surface unmapped CBN labels to callers, not just to logs — a silently dropped
  // currency is exactly the kind of gap someone pricing FX needs to know about.
  if (cbn && cbn.unmappedLabels.length > 0) {
    warnings.push(
      `CBN published ${cbn.unmappedLabels.length} unrecognised currency label(s): ` +
        `${cbn.unmappedLabels.join(', ')}. Those currencies may be missing.`,
    )
  }

  const payload: RatesResponse = {
    timestamp: now.toISOString(),
    base: 'NGN',
    data_age: {
      parallel_minutes: monierateAge,
      official_minutes: cbn ? ageMinutes(iso(cbn.fetchedAt), now) : null,
    },
    confidence,
    rates,
    spreads,
    trend_7d: trend7d,
  }
  if (warnings.length > 0) payload.warnings = warnings

  await putCachedRates(env, payload)
}
