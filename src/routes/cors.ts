import type { Context, Next } from 'hono'

import type { Env } from '../types/rates'

/**
 * CORS for every route.
 *
 * Registered before the payment middleware so preflight is answered without ever
 * reaching the paywall — a browser's OPTIONS probe carries no payment and must not
 * be charged, challenged, or 402'd.
 *
 * `Access-Control-Expose-Headers` is the part that is easy to miss and that makes
 * the difference between CORS "working" and x402 actually being usable from a
 * browser. Without it a cross-origin caller can read the status but not
 * `PAYMENT-REQUIRED`, so it can never learn what to pay — the whole protocol
 * happens in headers the browser would otherwise hide.
 */

const ALLOWED_METHODS = 'GET, OPTIONS'

/** Request headers a browser-based x402 client legitimately sends. */
const ALLOWED_HEADERS = ['content-type', 'accept', 'x-payment', 'payment-signature'].join(', ')

/**
 * Response headers a cross-origin caller must be able to read. The x402 flow is
 * carried entirely in these, so omitting any of them silently breaks browser
 * clients while leaving curl unaffected.
 */
const EXPOSED_HEADERS = [
  'payment-required',
  'payment-response',
  'x-settlement-usd',
  'x-settlement-scheme',
].join(', ')

/** One day. Preflight results are stable — the policy is static. */
const MAX_AGE = '86400'

export function corsHeaders(): Record<string, string> {
  return {
    // Public data behind a per-call payment, not a per-origin one: there is no
    // cookie, session or credential to protect, so `*` is correct rather than lax.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-expose-headers': EXPOSED_HEADERS,
    'access-control-max-age': MAX_AGE,
  }
}

export async function corsMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') {
    // 204 with no body. Answered here, before the paywall, so a preflight for a
    // paid route never becomes a 402 the browser would treat as a CORS failure.
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  await next()

  // Applied to whatever came back — including 402, 412 and 400 — since a client
  // that cannot read an error is no better off than one that cannot read a body.
  for (const [k, v] of Object.entries(corsHeaders())) {
    c.res.headers.set(k, v)
  }
}
