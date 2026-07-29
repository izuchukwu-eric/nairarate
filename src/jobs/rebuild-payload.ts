import { getDailySeries, getLatestOfficialRates } from '../cache/d1'
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

  /**
   * Official rates come from the `latest:cbn` KV payload when the CBN cron has
   * run, and from D1 when it has not.
   *
   * The D1 path matters on a fresh deploy: the CBN cron fires weekdays at 07:00
   * UTC, so a Friday-evening launch would otherwise serve `official: null` for
   * every currency — and therefore a null `parallel_vs_official_pct`, the headline
   * number — for around 60 hours, despite the backfill having 24 years of official
   * rates in D1 already.
   */
  const officialFromKv = cbn !== null && Object.keys(cbn.rates).length > 0
  const officialFallback = officialFromKv ? [] : await getLatestOfficialRates(env)
  const fallbackByCode = new Map(officialFallback.map((r) => [r.currency, r]))

  if (!officialFromKv) {
    console.warn(
      `rebuild-payload: latest:cbn is absent, serving official rates from D1 ` +
        `(${fallbackByCode.size} currencies). Expected before the first CBN cron run.`,
    )
  }

  const rates: Record<string, CurrencyRates> = {}

  for (const def of CURRENCIES) {
    // XAF borrows XOF's unified CFA official series; everything else uses its own.
    const officialCode = def.officialFrom ?? def.code
    const monierateRate = monierate?.rates[def.code]

    let official: OfficialQuote | null = null

    const kvRate = cbn?.rates[officialCode]
    const d1Rate = fallbackByCode.get(officialCode)

    if (kvRate) {
      official = {
        bid: kvRate.bid,
        ask: kvRate.ask,
        mid: kvRate.mid,
        source: CBN_OFFICIAL_SOURCE,
        // This currency's own business date, which may lag the payload's newest.
        updated_at: `${kvRate.rateDate}T00:00:00Z`,
        high: kvRate.high ?? null,
        low: kvRate.low ?? null,
        close: kvRate.close ?? null,
        turnover: kvRate.turnover ?? null,
        deal_count: kvRate.dealCount ?? null,
      }
    } else if (d1Rate && d1Rate.mid !== null) {
      official = {
        bid: d1Rate.bid,
        ask: d1Rate.ask,
        mid: d1Rate.mid,
        source: CBN_OFFICIAL_SOURCE,
        updated_at: `${d1Rate.rate_date}T00:00:00Z`,
        high: d1Rate.high,
        low: d1Rate.low,
        close: d1Rate.close,
        turnover: d1Rate.turnover,
        deal_count: d1Rate.deal_count,
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

  const newestOfficialDate = officialFallback.reduce<string | null>(
    (max, r) => (max === null || r.rate_date > max ? r.rate_date : max),
    null,
  )

  const monierateAge = ageMinutes(monierate ? iso(monierate.fetchedAt) : null, now)
  const { confidence, warnings } = computeConfidence({
    monierateAgeMinutes: monierateAge,
    cbnCurrent: isCbnCurrent(cbnStatus.lastOk, now),
    monierateErrored: monierateStatus.lastError !== null,
    cbnErrored: cbnStatus.lastError !== null,
    failedTickers: monierate?.failedTickers,
  })

  if (!officialFromKv && fallbackByCode.size > 0) {
    warnings.push(
      'Official rates are being served from stored history rather than a live CBN sync — ' +
        `most recent business date ${newestOfficialDate}. The CBN sync runs weekdays at 07:00 UTC.`,
    )
  }

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
      // On the D1 fallback path there is no fetch timestamp, so age is measured
      // from the newest business date served rather than reported as null.
      official_minutes: cbn
        ? ageMinutes(iso(cbn.fetchedAt), now)
        : ageMinutes(newestOfficialDate ? `${newestOfficialDate}T00:00:00Z` : null, now),
    },
    confidence,
    rates,
    spreads,
    trend_7d: trend7d,
  }
  if (warnings.length > 0) payload.warnings = warnings

  await putCachedRates(env, payload)
}
