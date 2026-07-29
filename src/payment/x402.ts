/**
 * x402 payment configuration.
 *
 * Built on @x402/hono 2.20.0 — the v2 SDK. Two consequences that drive everything
 * below, both verified against live facilitator `/supported` responses rather than
 * documentation:
 *
 *  1. **Networks are CAIP-2.** `Network` is typed `` `${string}:${string}` ``, so
 *     Base is `eip155:8453` and Base Sepolia `eip155:84532`. The v1 names `base`
 *     and `base-sepolia` do not even satisfy the type.
 *
 *  2. **The facilitator must speak x402Version 2.** Checked all three candidates:
 *
 *       facilitator.mogami.tech    v1 only, `exact`, networks `base`/`base-sepolia`
 *       facilitator.payai.network  v1 AND v2, `exact` + `upto` on eip155:8453
 *       x402.org/facilitator       v1 AND v2, `exact`/`upto`/`batch-settlement`,
 *                                  Base Sepolia only — no mainnet at all
 *
 *     Mogami advertises only `x402Version: 1` with legacy network names, so it
 *     cannot serve this SDK. PayAI is the only candidate offering v2 on Base
 *     mainnet, so it is primary there; x402.org covers Sepolia.
 *
 * No API keys and no account are needed for either: a resource server only
 * verifies and settles through the facilitator, it never signs. Hence no CDP.
 */

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
// RoutesConfig lives on the /server (and /http) subpath, not /types.
import type { RoutesConfig } from '@x402/core/server'
import type { Network } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { UptoEvmScheme } from '@x402/evm/upto/server'

import type { Env } from '../types/rates'

export type X402Network = 'base' | 'base-sepolia'

/** CAIP-2 identifiers. The v2 SDK accepts nothing else. */
export const CAIP2: Record<X402Network, Network> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
}

/**
 * Facilitators per network, in preference order.
 *
 * `x402ResourceServer` accepts an array of facilitator clients, so the backup is
 * genuine redundancy rather than a manual switch.
 *
 * Mogami is deliberately absent — see the file header. It would work only against
 * the legacy `x402-hono` v1 package, which pulls wagmi → @coinbase/wallet-sdk →
 * keccak, a native module that does not bundle for workerd.
 */
export const FACILITATORS: Record<X402Network, readonly string[]> = {
  // PayAI advertises v2 `exact` + `upto` on eip155:8453 — the only mainnet option.
  base: ['https://facilitator.payai.network'],
  // x402.org is the reference testnet facilitator; PayAI also serves Sepolia.
  'base-sepolia': ['https://x402.org/facilitator', 'https://facilitator.payai.network'],
}

export const PRICE_RATES = '$0.002'
export const PRICE_HISTORY = '$0.01'

export function resolveNetwork(env: Env): X402Network {
  const raw = env.X402_NETWORK?.trim().toLowerCase()
  if (raw === 'base' || raw === 'base-sepolia') return raw
  // Default to testnet: an accidental deploy should not take real money.
  if (raw) console.warn(`x402: unrecognised X402_NETWORK "${raw}", defaulting to base-sepolia`)
  return 'base-sepolia'
}

/**
 * Build the route payment requirements.
 *
 * `/v1/rates` takes `exact` alone — the price is a flat $0.002 and every x402
 * client implements `exact`.
 *
 * `/v1/rates/history` advertises **both** `upto` and `exact`. `accepts` is an
 * array and the client picks, so `upto` is available for usage-based pricing later
 * without making the endpoint uncallable today by the many clients that only
 * implement `exact`. Advertising `upto` alone would gate a paid endpoint behind
 * the less widely supported scheme for no present benefit.
 *
 * Note `upto` currently settles the full declared maximum: it authorises up to an
 * amount and the server declares the actual one at settlement. Charging by `days`
 * requested is the obvious use, and needs `setSettlementOverrides` from
 * @x402/hono in the handler — deliberately not wired, since pricing is flat today.
 */
/**
 * Body for an unpaid 402.
 *
 * The machine-readable requirements travel in the `PAYMENT-REQUIRED` header, and
 * the SDK's default body is `{}` — correct but opaque to anyone who has not read
 * the spec. This gives a human or a non-x402 client something actionable, without
 * restating the `accepts` array, which would only drift from the header.
 */
function unpaidBody(endpoint: string, price: string, network: Network) {
  return () => ({
    contentType: 'application/json',
    body: {
      error: 'payment_required',
      message: `${endpoint} costs ${price} per call, paid in USDC via the x402 protocol.`,
      price,
      network,
      how: 'Read the PAYMENT-REQUIRED response header for the payment requirements, ' +
        'or use an x402-capable client which handles this automatically.',
      free_endpoints: { 'GET /health': 'Source freshness — check before paying.' },
      methodology: 'https://nairarate.dev/methodology',
    },
  })
}

export function buildRoutes(payTo: string, network: Network): RoutesConfig {
  return {
    'GET /v1/rates': {
      accepts: [{ scheme: 'exact', payTo, price: PRICE_RATES, network }],
      unpaidResponseBody: unpaidBody('GET /v1/rates', PRICE_RATES, network),
      description:
        'Nigerian FX rates across three markets — CBN official, parallel and stablecoin street ' +
        'prices — with spreads, 7-day trends and a confidence score.',
      mimeType: 'application/json',
      serviceName: 'nairarate.dev',
      tags: ['fx', 'nigeria', 'ngn', 'exchange-rates', 'parallel-market', 'stablecoin'],
    },
    'GET /v1/rates/history': {
      accepts: [
        { scheme: 'upto', payTo, price: PRICE_HISTORY, network },
        { scheme: 'exact', payTo, price: PRICE_HISTORY, network },
      ],
      unpaidResponseBody: unpaidBody('GET /v1/rates/history', PRICE_HISTORY, network),
      description:
        'Daily historical Nigerian FX rate series by currency and market, with trend, high and low. ' +
        'Official series reach back to 2001.',
      mimeType: 'application/json',
      serviceName: 'nairarate.dev',
      tags: ['fx', 'nigeria', 'ngn', 'historical', 'time-series'],
    },
  }
}

/**
 * Assemble the resource server for a network.
 *
 * Both scheme servers are registered because `/v1/rates/history` advertises both.
 * They come from the `@x402/evm/{exact,upto}/server` subpaths — importing
 * `ExactEvmScheme` from the package root gets the *client* class instead, which
 * requires a signer and is the wrong side of the protocol.
 */
export function buildResourceServer(network: Network, facilitatorUrls: readonly string[]): x402ResourceServer {
  const clients = facilitatorUrls.map((url) => new HTTPFacilitatorClient({ url }))

  return new x402ResourceServer(clients)
    .register(network, new ExactEvmScheme())
    .register(network, new UptoEvmScheme())
}

export interface X402Setup {
  network: X402Network
  caip2: Network
  payTo: string
  facilitatorUrls: readonly string[]
  routes: RoutesConfig
  server: x402ResourceServer
}

/**
 * Resolve the full configuration, or null when it cannot be built.
 *
 * Returns null rather than throwing so the Worker still boots and serves /health
 * with payment disabled — a misconfigured payTo should be visible and diagnosable,
 * not a cold-start crash loop.
 */
export function setupX402(env: Env): X402Setup | null {
  const payTo = env.X402_WALLET_ADDRESS?.trim()

  if (!payTo) {
    console.error('x402: X402_WALLET_ADDRESS is not set — /v1/* payment gating is DISABLED')
    return null
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    console.error(`x402: X402_WALLET_ADDRESS "${payTo}" is not a 20-byte hex address — gating DISABLED`)
    return null
  }

  const network = resolveNetwork(env)
  const caip2 = CAIP2[network]
  const facilitatorUrls = FACILITATORS[network]

  return {
    network,
    caip2,
    payTo,
    facilitatorUrls,
    routes: buildRoutes(payTo, caip2),
    server: buildResourceServer(caip2, facilitatorUrls),
  }
}
