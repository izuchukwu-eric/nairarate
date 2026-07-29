import type { Context } from 'hono'

import { getCachedRates } from '../cache/kv'
import { CURRENCY_CODES, getCurrency } from '../config/currencies'
import type { CurrencyRates, Env, Market, RatesResponse } from '../types/rates'

const MARKETS: readonly Market[] = ['official', 'parallel', 'crypto_street']

/**
 * GET /v1/rates — x402 gated.
 *
 * A single KV read, then filtering. No D1, no upstream call: spreads, trends and
 * confidence are precomputed by the cron, so a paid request cannot be made slow
 * by Monierate or CBN being slow, and cannot fail because they are down.
 */
export async function ratesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const payload = await getCachedRates(c.env)

  if (!payload) {
    // Only reachable before the first successful cron run. A 503 is correct here —
    // there is genuinely nothing to sell yet, and the caller should not be charged
    // for an empty body.
    return c.json(
      {
        error: 'no_data',
        message:
          'No rate data has been collected yet. The collectors run every 15 minutes; ' +
          'check GET /health for source freshness.',
      },
      503,
      { 'cache-control': 'no-store' },
    )
  }

  const currenciesParam = c.req.query('currencies')
  const marketsParam = c.req.query('markets')

  const wantedCurrencies = parseCurrencies(currenciesParam)
  if ('error' in wantedCurrencies) {
    return c.json({ error: 'invalid_currencies', message: wantedCurrencies.error }, 400)
  }

  const wantedMarkets = parseMarkets(marketsParam)
  if ('error' in wantedMarkets) {
    return c.json({ error: 'invalid_markets', message: wantedMarkets.error }, 400)
  }

  return c.json(project(payload, wantedCurrencies.codes, wantedMarkets.markets), 200, {
    // The cron refreshes every 15 minutes; a short cache is safe and keeps repeat
    // callers cheap. Payment is enforced by middleware ahead of this handler.
    'cache-control': 'public, max-age=60',
  })
}

function parseCurrencies(
  raw: string | undefined,
): { codes: string[] } | { error: string } {
  if (!raw) return { codes: [...CURRENCY_CODES] }

  const requested = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)

  if (requested.length === 0) return { codes: [...CURRENCY_CODES] }

  const unknown = requested.filter((code) => !getCurrency(code))
  if (unknown.length > 0) {
    return {
      error:
        `Unsupported currency code(s): ${unknown.join(', ')}. ` +
        `Supported: ${CURRENCY_CODES.join(', ')}.`,
    }
  }

  // Dedupe while preserving registry order so the response shape is stable.
  const wanted = new Set(requested)
  return { codes: CURRENCY_CODES.filter((code) => wanted.has(code)) }
}

function parseMarkets(raw: string | undefined): { markets: Market[] } | { error: string } {
  if (!raw || raw.trim().toLowerCase() === 'all') return { markets: [...MARKETS] }

  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)

  const invalid = requested.filter((m) => !MARKETS.includes(m as Market))
  if (invalid.length > 0) {
    return {
      error: `Unsupported market(s): ${invalid.join(', ')}. Supported: ${MARKETS.join(', ')}, all.`,
    }
  }

  return { markets: MARKETS.filter((m) => requested.includes(m)) }
}

/**
 * Narrow the payload to the requested currencies and markets.
 *
 * Filtered-out markets are set to null rather than deleted, so the response shape
 * is identical whether or not a filter was used — a caller parsing
 * `rates.USD.parallel` never has to handle the key being absent versus null.
 */
function project(
  payload: RatesResponse,
  codes: readonly string[],
  markets: readonly Market[],
): RatesResponse {
  const rates: Record<string, CurrencyRates> = {}
  const spreads: RatesResponse['spreads'] = {}
  const trend: RatesResponse['trend_7d'] = {}

  for (const code of codes) {
    const source = payload.rates[code]
    if (!source) continue

    rates[code] = {
      official: markets.includes('official') ? source.official : null,
      parallel: markets.includes('parallel') ? source.parallel : null,
      crypto_street: markets.includes('crypto_street') ? source.crypto_street : null,
      ...(source.note ? { note: source.note } : {}),
    }

    const s = payload.spreads[code]
    if (s) spreads[code] = s
    const t = payload.trend_7d[code]
    if (t) trend[code] = t
  }

  return {
    ...payload,
    rates,
    spreads,
    trend_7d: trend,
  }
}
