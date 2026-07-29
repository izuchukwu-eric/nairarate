import type { Context } from 'hono'

import { CURRENCIES, CURRENCY_CODES } from '../config/currencies'
import { PRICE_HISTORY, PRICE_RATES, resolveNetwork, CAIP2 } from '../payment/x402'
import type { Env } from '../types/rates'

/**
 * Static discovery surfaces.
 *
 * Bazaar (declared per-route in src/payment/x402.ts) is the protocol-native way to
 * be found, but the ecosystem has also converged on a couple of plain HTTP
 * conventions that crawlers and agents look for directly. These are free and
 * unauthenticated by design — an agent has to be able to learn what this costs
 * before it can decide to pay.
 *
 * Everything here is derived from the currency registry and the payment config, so
 * it cannot drift from what the API actually serves.
 */

function coverage() {
  return CURRENCIES.map((c) => ({
    code: c.code,
    name: c.name,
    markets: [
      ...(c.cbnOfficial ? ['official'] : []),
      ...(c.monierateMarket ? [c.monierateMarket] : []),
    ],
    ...(c.note ? { note: c.note } : {}),
  }))
}

/**
 * GET /.well-known/x402 — machine-readable service manifest.
 *
 * The `x402` key mirrors what the 402 challenge advertises; `endpoints` describes
 * the free and paid surface so an indexer does not have to probe for it.
 */
export function wellKnownX402Handler(c: Context<{ Bindings: Env }>): Response {
  const network = CAIP2[resolveNetwork(c.env)]
  const origin = new URL(c.req.url).origin

  return c.json(
    {
      x402Version: 2,
      name: 'nairarate.dev',
      description:
        'Nigerian FX intelligence: the CBN official rate, the parallel (street) market rate ' +
        'and USDT/USDC street prices, with the spreads between them, 7-day trends and a ' +
        'freshness-based confidence score.',
      endpoints: [
        {
          path: '/health',
          method: 'GET',
          price: null,
          description: 'Per-source freshness. Free — check before paying.',
        },
        {
          path: '/v1/rates',
          method: 'GET',
          price: PRICE_RATES,
          network,
          schemes: ['exact'],
          description: 'All markets, all currencies, with spreads and 7-day trends.',
          parameters: {
            currencies: `Optional comma-separated filter. Default: all.`,
            markets: 'Optional: official, parallel, crypto_street, or all. Default: all.',
          },
        },
        {
          path: '/v1/rates/history',
          method: 'GET',
          price: PRICE_HISTORY,
          network,
          schemes: ['upto', 'exact'],
          description:
            'Daily series for one currency and market, with trend, high and low. ' +
            'Official series reach back to 2001-12-10.',
          parameters: {
            currency: 'Required.',
            market: 'Required: official, parallel, or crypto_street.',
            days: 'Optional 1-30. Default 7.',
          },
        },
      ],
      base: 'NGN',
      conventions: {
        bid: 'NGN received per unit of foreign currency (the low side).',
        ask: 'NGN paid per unit of foreign currency (the high side).',
        mid: 'Midpoint of bid and ask, or the single published rate where only one exists.',
      },
      coverage: coverage(),
      sources: {
        official: 'Central Bank of Nigeria (NFEM and published exchange rates).',
        parallel: 'Monierate — aggregated across 40+ changers, screened and median-aggregated.',
      },
      methodology: `${origin}/methodology`,
      links: { llms: `${origin}/llms.txt` },
    },
    200,
    { 'cache-control': 'public, max-age=3600' },
  )
}

/**
 * GET /llms.txt — plain-text description for agents and LLM crawlers.
 *
 * Deliberately blunt about coverage gaps. An agent that discovers this and then
 * requests CHF parallel gets a 400 it could have avoided.
 */
export function llmsTxtHandler(c: Context<{ Bindings: Env }>): Response {
  const origin = new URL(c.req.url).origin
  const network = CAIP2[resolveNetwork(c.env)]

  const withParallel = CURRENCIES.filter((x) => x.monierateMarket === 'parallel').map((x) => x.code)
  const street = CURRENCIES.filter((x) => x.monierateMarket === 'crypto_street').map((x) => x.code)
  const officialOnly = CURRENCIES.filter((x) => x.cbnOfficial && !x.monierateMarket).map((x) => x.code)

  const body = `# nairarate.dev

> Nigerian FX intelligence across three markets in one call: the CBN official
> rate, the parallel ("black market") rate, and USDT/USDC street prices — plus
> the spreads between them, 7-day trends, and a confidence score.

Paid per call in USDC on Base via the x402 protocol (${network}). No API key, no
account, no subscription. All rates are NGN per unit of the quoted currency.

## Why this exists

No global FX API publishes Nigeria's parallel market rate or USDT/NGN street
price. Frankfurter, ExchangeRate-API and similar carry the official mid only. The
spread between official, parallel and stablecoin rates is the signal that matters
for anything priced in or around naira, and it is not otherwise available as a
structured API.

## Endpoints

GET /health                 Free. Per-source freshness. Check before paying.
GET /v1/rates               ${PRICE_RATES}. All markets and currencies, spreads, 7-day trends.
                            ?currencies=USD,USDT   optional filter
                            ?markets=official|parallel|crypto_street|all
GET /v1/rates/history       ${PRICE_HISTORY}. Daily series for one currency and market.
                            ?currency=USD (required)
                            ?market=official|parallel|crypto_street (required)
                            ?days=1..30 (default 7)
GET /.well-known/x402       Free. Machine-readable manifest.
GET /methodology            Free. How the rates are derived and screened.

## Coverage is asymmetric — read this before requesting

Official + parallel:  ${withParallel.join(', ')}
Stablecoin street:    ${street.join(', ')}
Official only:        ${officialOnly.join(', ')}

Requesting a market a currency does not carry returns 400 with an explanation
rather than an empty result you paid for. Currencies without a counterpart market
report null for that market and a null spread — never a fabricated value.

Official history reaches back to 2001-12-10. Parallel and street history
accumulates from this deployment's first daily roll-up, so it is shallower.

## Conventions

bid   NGN received per unit of foreign currency (the low side)
ask   NGN paid per unit of foreign currency (the high side)
mid   midpoint, or the single published rate where only one side exists

provider_count is the number of independent street quotes behind a parallel rate.
It ranges from 43 (USD) down to 1 for thinly quoted currencies — check it before
relying on a rate.

confidence is high | medium | low | degraded, from source freshness. Data is
always returned, even at degraded: a stale rate is more useful to an agent
mid-task than an error. warnings explains any downgrade.

## Notes

- CBN publishes weekdays only, and partially — some currencies lag others by a
  day. Each carries its own updated_at.
- Parallel rates are screened before aggregation: the central bank and reference
  feeds quote inside the upstream provider list, and remittance corridors report
  a missing side as zero. Unscreened, USD reads ~1181 against a true ~1392.
  See ${origin}/methodology.

## Example

  curl ${origin}/health
  curl ${origin}/v1/rates?currencies=USD,USDT
`

  return c.text(body, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  })
}

/** GET /methodology — the screening rules, as plain text. Free. */
export function methodologyHandler(c: Context<{ Bindings: Env }>): Response {
  const origin = new URL(c.req.url).origin

  const body = `# nairarate.dev — methodology

How these rates are derived, so you can decide whether to trust them.

## Sources

Official   Central Bank of Nigeria's own JSON endpoints. USD uses the NFEM
           volume-weighted average, CBN's stated official rate for the day, and
           carries high/low/close and market turnover.
Parallel   Every changer quoting the pair via Monierate, aggregated here rather
           than taken pre-blended.

## Screening

Raw provider lists cannot be averaged. Unfiltered, USD returns a mid of 1181
against a true ~1392. Four exclusions:

1. A quote of 0 means "no quote on that side", not a rate of zero. Remittance
   corridors publish only a send rate — 19 of 65 USD providers. Averaging the
   zero halves the mid.
2. The central bank itself quotes inside the provider list. Including it drags
   the parallel rate toward the official one and understates the spread, which is
   the number this API exists to publish.
3. Reference and institutional feeds are not street rates: one quotes bid equal
   to ask, another a mechanical 0.50% band around a reference mid.
4. Outright bad data. One feed quoted GBP at 130 against a ~1850 market.

Survivors are aggregated by median, not mean — robust to the long tail of
outlying changers. A quote more than 3x from the peer median is discarded.
provider_count reports the surviving two-sided quotes, so a rate resting on a
single provider is visible as such.

Official history is screened against neighbouring days, which catches genuine
CBN data-entry errors (a Danish krone printed at 198,024 against a ~200
baseline). Two-sided bands are reconciled against the mid, which CBN publishes
directly; where a band is incoherent the offending side is dropped and the mid
kept.

## Validation

Our screened USD/NGN parallel mid, 1392.47, against Monierate's own independently
computed composite, 1397.82 — a 0.4% variance between different methodologies on
the same market.

Full detail: ${origin}/llms.txt
`

  return c.text(body, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  })
}
