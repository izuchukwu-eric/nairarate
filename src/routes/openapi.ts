import type { Context } from 'hono'

import { CURRENCIES, CURRENCY_CODES } from '../config/currencies'
import { PRICE_HISTORY, PRICE_RATES, resolveNetwork, CAIP2 } from '../payment/x402'
import type { Env } from '../types/rates'

/**
 * GET /openapi.json — OpenAPI 3.1 description of the service.
 *
 * Generated from the currency registry and the payment constants rather than
 * hand-written, so it cannot drift from what the API actually serves. A stale spec
 * is worse than no spec: it makes an agent confident about the wrong thing.
 */

const MARKETS = ['official', 'parallel', 'crypto_street'] as const

const quoteSchema = (withProviderCount: boolean) => ({
  type: 'object',
  nullable: true,
  description: 'Null when this currency has no source for this market.',
  properties: {
    bid: { type: 'number', nullable: true, description: 'NGN received per unit of foreign currency (low side).' },
    ask: { type: 'number', nullable: true, description: 'NGN paid per unit of foreign currency (high side).' },
    mid: { type: 'number', nullable: true, description: 'Midpoint, or the single published rate.' },
    ...(withProviderCount
      ? {
          provider_count: {
            type: 'integer',
            description:
              'Independent street quotes behind this rate, after screening. Ranges from 43 (USD) ' +
              'down to 1 for thinly quoted currencies — check before relying on it.',
          },
        }
      : {}),
    source: { type: 'string' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['bid', 'ask', 'mid', 'source', 'updated_at'],
})

export function openApiHandler(c: Context<{ Bindings: Env }>): Response {
  const origin = new URL(c.req.url).origin
  const network = CAIP2[resolveNetwork(c.env)]

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'nairarate.dev',
      version: '1.0.0',
      summary: 'Nigerian FX intelligence — official, parallel and stablecoin street rates.',
      description:
        'Returns the CBN official rate, the parallel (street) market rate and USDT/USDC street ' +
        'prices for NGN in a single call, with the spreads between them, 7-day trends and a ' +
        'confidence score.\n\n' +
        'Paid per call in USDC on Base via the x402 protocol — no API key and no account. An ' +
        'unpaid request returns 402 with the payment requirements in the `PAYMENT-REQUIRED` ' +
        'header; an x402-capable client handles this automatically.\n\n' +
        'Coverage is deliberately asymmetric. A market a currency has no source for is reported ' +
        'as `null`, never fabricated, and requesting such a combination on /v1/rates/history ' +
        `returns 400 with an explanation. See ${origin}/methodology for how rates are screened.`,
      license: { name: 'Proprietary' },
    },
    servers: [{ url: origin }],
    paths: {
      '/health': {
        get: {
          summary: 'Source freshness. Free.',
          description: 'Check before paying. Returns 200 even when degraded — the body carries the status.',
          responses: {
            '200': {
              description: 'Freshness per source.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'degraded'] },
                      sources: {
                        type: 'object',
                        additionalProperties: {
                          type: 'object',
                          properties: {
                            last_success: { type: 'string', nullable: true, format: 'date-time' },
                            age_minutes: { type: 'integer', nullable: true },
                            healthy: { type: 'boolean' },
                            last_error: { type: 'string', nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/rates': {
        get: {
          summary: `All markets, all currencies. ${PRICE_RATES} per call.`,
          description: `Paid via x402 in USDC on ${network}, scheme \`exact\`.`,
          parameters: [
            {
              name: 'currencies',
              in: 'query',
              required: false,
              description: 'Comma-separated filter. Default: all.',
              schema: { type: 'string', example: 'USD,USDT,USDC' },
            },
            {
              name: 'markets',
              in: 'query',
              required: false,
              description: 'Comma-separated, or `all`. Default: all.',
              schema: { type: 'string', enum: [...MARKETS, 'all'], example: 'all' },
            },
          ],
          responses: {
            '200': { description: 'Rates.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RatesResponse' } } } },
            '400': { description: 'Unsupported currency or market.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '402': { $ref: '#/components/responses/PaymentRequired' },
            '503': { description: 'No data collected yet. Only reachable before the first sync.' },
          },
        },
      },
      '/v1/rates/history': {
        get: {
          summary: `Daily historical series. ${PRICE_HISTORY} per call.`,
          description:
            `Paid via x402 in USDC on ${network}. Advertises both \`upto\` and \`exact\` — the ` +
            'client picks. Official series reach back to 2001-12-10; parallel and street series ' +
            'accumulate from this deployment and are shallower.',
          parameters: [
            { name: 'currency', in: 'query', required: true, schema: { type: 'string', enum: [...CURRENCY_CODES] } },
            { name: 'market', in: 'query', required: true, schema: { type: 'string', enum: [...MARKETS] } },
            { name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 30, default: 7 } },
          ],
          responses: {
            '200': { description: 'Series.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HistoryResponse' } } } },
            '400': {
              description:
                'Missing or invalid parameter, or a currency/market combination with no source ' +
                '(the message says which). Returned instead of an empty result you paid for.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '402': { $ref: '#/components/responses/PaymentRequired' },
          },
        },
      },
      '/.well-known/x402': { get: { summary: 'Service manifest. Free.', responses: { '200': { description: 'Manifest.' } } } },
      '/llms.txt': { get: { summary: 'Plain-text description for agents. Free.', responses: { '200': { description: 'Text.' } } } },
      '/methodology': { get: { summary: 'How rates are derived and screened. Free.', responses: { '200': { description: 'Text.' } } } },
      '/openapi.json': { get: { summary: 'This document. Free.', responses: { '200': { description: 'OpenAPI 3.1 spec.' } } } },
    },
    components: {
      responses: {
        PaymentRequired: {
          description:
            'Payment required. Requirements are in the `PAYMENT-REQUIRED` response header, ' +
            'base64-encoded JSON containing the `accepts` array.',
          headers: {
            'PAYMENT-REQUIRED': {
              description: 'Base64-encoded x402 payment requirements.',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' } },
          required: ['error', 'message'],
        },
        MarketQuote: quoteSchema(true),
        OfficialQuote: {
          allOf: [
            quoteSchema(false),
            {
              type: 'object',
              description: 'high/low/close/turnover are populated for USD only, from CBN NFEM.',
              properties: {
                high: { type: 'number', nullable: true },
                low: { type: 'number', nullable: true },
                close: { type: 'number', nullable: true },
                turnover: { type: 'number', nullable: true, description: 'NFEM total turnover, USD.' },
                deal_count: { type: 'integer', nullable: true },
              },
            },
          ],
        },
        CurrencyRates: {
          type: 'object',
          properties: {
            official: { $ref: '#/components/schemas/OfficialQuote' },
            parallel: { $ref: '#/components/schemas/MarketQuote' },
            crypto_street: { $ref: '#/components/schemas/MarketQuote' },
            note: { type: 'string', description: 'Present where coverage needs explaining, e.g. the shared CFA official series.' },
          },
          required: ['official', 'parallel', 'crypto_street'],
        },
        Spreads: {
          type: 'object',
          description: 'Percentage differences. Each field is null where either side is absent.',
          properties: {
            parallel_vs_official_pct: { type: 'number', nullable: true },
            usdt_vs_official_pct: { type: 'number', nullable: true },
            usdt_vs_parallel_pct: { type: 'number', nullable: true },
            usdc_vs_official_pct: { type: 'number', nullable: true },
            usdc_vs_parallel_pct: { type: 'number', nullable: true },
          },
        },
        TrendBlock: {
          type: 'object',
          description:
            'Direction is from the naira\'s point of view: a rising NGN-per-unit rate is ' +
            '`depreciating`. Null when the series is too short to judge.',
          properties: {
            parallel_direction: { type: 'string', nullable: true, enum: ['appreciating', 'depreciating', 'stable', null] },
            official_direction: { type: 'string', nullable: true, enum: ['appreciating', 'depreciating', 'stable', null] },
            spread_direction: { type: 'string', nullable: true, enum: ['compressing', 'widening', 'stable', null] },
          },
        },
        RatesResponse: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', format: 'date-time' },
            base: { type: 'string', const: 'NGN' },
            data_age: {
              type: 'object',
              properties: {
                parallel_minutes: { type: 'integer', nullable: true },
                official_minutes: { type: 'integer', nullable: true },
              },
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', 'degraded'],
              description:
                'Data is always returned, even at `degraded` — a stale rate is more useful to an ' +
                'agent mid-task than an error. `warnings` explains any downgrade.',
            },
            warnings: { type: 'array', items: { type: 'string' } },
            rates: { type: 'object', additionalProperties: { $ref: '#/components/schemas/CurrencyRates' } },
            spreads: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Spreads' } },
            trend_7d: { type: 'object', additionalProperties: { $ref: '#/components/schemas/TrendBlock' } },
          },
          required: ['timestamp', 'base', 'data_age', 'confidence', 'rates', 'spreads', 'trend_7d'],
        },
        HistoryResponse: {
          type: 'object',
          properties: {
            currency: { type: 'string' },
            market: { type: 'string', enum: [...MARKETS] },
            days: { type: 'integer' },
            snapshots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', format: 'date' },
                  bid: { type: 'number', nullable: true },
                  ask: { type: 'number', nullable: true },
                  mid: { type: 'number', nullable: true },
                },
              },
            },
            trend: {
              type: 'object',
              properties: {
                direction: { type: 'string', nullable: true },
                change_pct: { type: 'number', nullable: true },
                high: { type: 'number', nullable: true },
                low: { type: 'number', nullable: true },
              },
            },
            note: { type: 'string' },
          },
          required: ['currency', 'market', 'days', 'snapshots', 'trend'],
        },
      },
    },
    'x-coverage': CURRENCIES.map((cur) => ({
      code: cur.code,
      markets: [...(cur.cbnOfficial ? ['official'] : []), ...(cur.monierateMarket ? [cur.monierateMarket] : [])],
    })),
  }

  // 60s, not an hour: the spec quotes prices, and a stale advertised price that
  // disagrees with the live 402 challenge can break a caller's budget check.
  return c.json(spec, 200, { 'cache-control': 'public, max-age=60' })
}
