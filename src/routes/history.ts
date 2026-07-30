import type { Context } from 'hono'
import { setSettlementOverrides } from '@x402/hono'
import { decodePaymentSignatureHeader } from '@x402/core/http'

import { getDailySeries } from '../cache/d1'
import { summariseTrend } from '../compute/trend'
import { getCurrency } from '../config/currencies'
import { DEFAULT_DAYS, MAX_DAYS, settlementTierForDays } from '../config/pricing'
import { PRICE_HISTORY } from '../payment/x402'
import type { Env, HistoryResponse, HistorySnapshot, Market } from '../types/rates'

const MARKETS: readonly Market[] = ['official', 'parallel', 'crypto_street']

/**
 * GET /v1/rates/history — x402 gated.
 *
 * Reads rate_daily only. Official series are backfilled from CBN's own history to
 * 2001-12-10, so this answers with real depth from day one; parallel and street
 * series begin accumulating from the first daily roll-up after deploy, and the
 * response note says which it gave you.
 *
 * Pricing is tiered by window size. The route advertises `upto` at the cap
 * (PRICE_HISTORY) and declares the actual amount at settlement via
 * `setSettlementOverrides`, so a caller asking for a week is not charged for a
 * year — see HISTORY_TIERS in src/config/pricing.ts.
 *
 * Partial settlement exists only in `upto`. A client that picks `exact` from
 * `accepts` settles the full cap regardless of `days`, because `exact` authorises
 * and captures the same amount. `exact` is still offered because it is far more
 * widely implemented, and the tier table is published on every surface that quotes
 * the price so the trade-off is visible before paying rather than after.
 */
export async function historyHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const currencyParam = c.req.query('currency')
  const marketParam = c.req.query('market')
  const daysParam = c.req.query('days')

  if (!currencyParam) {
    return c.json({ error: 'missing_currency', message: 'The `currency` parameter is required.' }, 400)
  }
  if (!marketParam) {
    return c.json(
      { error: 'missing_market', message: `The \`market\` parameter is required. One of: ${MARKETS.join(', ')}.` },
      400,
    )
  }

  const def = getCurrency(currencyParam)
  if (!def) {
    return c.json(
      { error: 'invalid_currency', message: `Unsupported currency: ${currencyParam}.` },
      400,
    )
  }

  const market = marketParam.trim().toLowerCase() as Market
  if (!MARKETS.includes(market)) {
    return c.json(
      { error: 'invalid_market', message: `Unsupported market: ${marketParam}. One of: ${MARKETS.join(', ')}.` },
      400,
    )
  }

  const days = parseDays(daysParam)
  if ('error' in days) {
    return c.json({ error: 'invalid_days', message: days.error }, 400)
  }

  // Reject combinations we know carry no data, before spending a D1 query — and
  // before the caller wonders why they paid for an empty array.
  const unsupported = describeUnsupported(def.code, market)
  if (unsupported) {
    return c.json({ error: 'no_such_series', message: unsupported }, 400)
  }

  // XAF shares XOF's unified CFA official series.
  const seriesCurrency = market === 'official' ? (def.officialFrom ?? def.code) : def.code
  const rows = await getDailySeries(c.env, seriesCurrency, market, days.value)
  const trend = summariseTrend(rows)

  const snapshots: HistorySnapshot[] = rows.map((r) => ({
    date: r.rate_date,
    bid: r.bid,
    ask: r.ask,
    mid: r.mid,
  }))

  // An empty series is a 400, not a 200 with an empty array.
  //
  // This is what stops a caller paying for nothing: the x402 middleware checks the
  // handler's status after next() and, for anything >= 400, cancels the verified
  // payment instead of settling it. A 200 carrying `snapshots: []` would charge the
  // full price for no data. The explanation still travels in the body.
  if (snapshots.length === 0) {
    const reason =
      market === 'official'
        ? 'CBN publishes on weekdays only, and not on Nigerian public holidays. Widen `days`.'
        : 'Parallel and street series accumulate from this deployment\'s daily roll-up, so they ' +
          'are shallower than the official series, which reaches back to 2001-12-10. Widen `days` ' +
          'or use market=official.'

    return c.json(
      {
        error: 'no_data_in_window',
        message:
          `No ${market} rows for ${def.code} in the last ${days.value} day(s). ${reason} ` +
          'You have not been charged for this request.',
        currency: def.code,
        market,
        days: days.value,
        ...(def.note ? { note: def.note } : {}),
      },
      400,
    )
  }

  const body: HistoryResponse = {
    currency: def.code,
    market,
    days: days.value,
    snapshots,
    trend: {
      direction: trend.direction,
      change_pct: trend.changePct,
      high: trend.high,
      low: trend.low,
    },
  }

  const notes: string[] = []
  if (def.note) notes.push(def.note)
  if (trend.points < 2) {
    notes.push('Only one day of data in this window, so no direction or change could be computed.')
  }
  if (notes.length > 0) body.note = notes.join(' ')

  // Declare the tiered amount — but only when the caller actually paid with `upto`.
  //
  // An override rewrites `requirements.amount` before settlement. On `exact` that
  // would ask the facilitator to settle a different amount than the payload
  // authorised, which is not what `exact` means and would either be rejected or
  // settle wrongly. The scheme the client chose is in the X-PAYMENT payload's
  // `accepted` requirements, so read it rather than assuming.
  const tier = settlementTierForDays(days.value)
  const paidScheme = detectPaidScheme(c)

  if (paidScheme === 'upto') {
    setSettlementOverrides(c, { amount: tier.amount })
  }

  return c.json(body, 200, {
    'cache-control': 'public, max-age=300',
    // What was actually charged, so a caller can reconcile without decoding the
    // receipt. `exact` settles the advertised cap; only `upto` gets the tier.
    'x-settlement-usd': paidScheme === 'upto' ? tier.usd : PRICE_HISTORY,
    'x-settlement-scheme': paidScheme ?? 'unknown',
  })
}

/**
 * Which scheme the caller paid with, from the X-PAYMENT header.
 *
 * Returns null when the header is absent or unparseable — in which case no
 * override is applied, which is the safe direction: the caller settles the
 * advertised amount rather than an amount their scheme may not support.
 */
function detectPaidScheme(c: Context<{ Bindings: Env }>): string | null {
  const header = c.req.header('x-payment')
  if (!header) return null
  try {
    return decodePaymentSignatureHeader(header).accepted?.scheme ?? null
  } catch {
    return null
  }
}

function parseDays(raw: string | undefined): { value: number } | { error: string } {
  if (!raw) return { value: DEFAULT_DAYS }

  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
    return { error: `\`days\` must be an integer between 1 and ${MAX_DAYS}. Got: ${raw}.` }
  }
  return { value: n }
}

/**
 * Explain a currency/market combination that has no source, rather than returning
 * an empty array a caller has paid for.
 */
function describeUnsupported(code: string, market: Market): string | null {
  const def = getCurrency(code)
  if (!def) return null

  if (market === 'official' && !def.cbnOfficial) {
    return `CBN publishes no official rate for ${code}. Try market=parallel.`
  }
  if (market === 'parallel' && def.monierateMarket !== 'parallel') {
    return def.monierateMarket === 'crypto_street'
      ? `${code} is a stablecoin — use market=crypto_street.`
      : `No parallel market source carries ${code}. Try market=official.`
  }
  if (market === 'crypto_street' && def.monierateMarket !== 'crypto_street') {
    return `${code} has no crypto street price. Try market=parallel or market=official.`
  }

  return null
}
