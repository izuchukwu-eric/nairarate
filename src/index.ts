import { Hono } from 'hono'
import { paymentMiddleware } from '@x402/hono'

import { setupX402 } from './payment/x402'
import type { X402Setup } from './payment/x402'
import { syncCbn } from './jobs/sync-cbn'
import { syncMonierate } from './jobs/sync-monierate'
import {
  llmsTxtHandler,
  methodologyHandler,
  wellKnownX402Handler,
} from './routes/discovery'
import { healthHandler } from './routes/health'
import { openApiHandler } from './routes/openapi'
import { historyHandler } from './routes/history'
import { ratesHandler } from './routes/rates'
import type { Env } from './types/rates'

const app = new Hono<{ Bindings: Env }>()

// Free routes, registered before any payment middleware. Discovery has to be free:
// an agent cannot decide to pay for something it cannot first read about.
app.get('/health', healthHandler)
app.get('/.well-known/x402', wellKnownX402Handler)
app.get('/llms.txt', llmsTxtHandler)
app.get('/methodology', methodologyHandler)
app.get('/openapi.json', openApiHandler)

app.get('/', (c) =>
  c.json({
    name: 'nairarate.dev',
    description:
      'Nigerian FX intelligence — CBN official, parallel market and stablecoin street rates, ' +
      'paid per call via x402 in USDC on Base.',
    endpoints: {
      'GET /health': 'Source freshness. Free.',
      'GET /v1/rates': 'All markets, all currencies. $0.002.',
      'GET /v1/rates/history': 'Daily historical series. $0.01.',
    },
    conventions: {
      base: 'NGN — every rate is naira per unit of the quoted currency.',
      bid: 'NGN received per unit of foreign currency (the low side).',
      ask: 'NGN paid per unit of foreign currency (the high side).',
    },
    discovery: {
      'GET /.well-known/x402': 'Machine-readable service manifest.',
      'GET /llms.txt': 'Plain-text description for agents.',
      'GET /methodology': 'How the rates are derived and screened.',
      'GET /openapi.json': 'OpenAPI 3.1 spec.',
    },
    docs: 'https://nairarate.dev',
  }),
)

/**
 * x402 payment gating on /v1/*.
 *
 * Built once per isolate and memoised: constructing the resource server sets up
 * facilitator clients and scheme registrations, and doing that per request would
 * add latency to every paid call.
 *
 * `paymentMiddleware(routes, server)` — the route map goes in directly, with each
 * route's requirements under `accepts`. Note the second argument is required: the
 * single-argument form in some examples does not typecheck against 2.20.0.
 */
let x402: X402Setup | null | undefined

app.use('/v1/*', async (c, next) => {
  // Bindings are only available per request, so this is built on first use and
  // then reused for the lifetime of the isolate.
  if (x402 === undefined) x402 = setupX402(c.env)

  if (x402 === null) {
    // No usable payTo. Fail closed rather than serving paid data for free.
    return c.json(
      {
        error: 'payment_unavailable',
        message: 'Payment is not configured on this deployment. GET /health remains free.',
      },
      503,
    )
  }

  return paymentMiddleware(x402.routes, x402.server)(c, next)
})

app.get('/v1/rates', ratesHandler)
app.get('/v1/rates/history', historyHandler)

app.notFound((c) => c.json({ error: 'not_found', message: `No route for ${c.req.path}` }, 404))

app.onError((err, c) => {
  console.error('unhandled error', err)
  return c.json({ error: 'internal_error', message: 'Unexpected error.' }, 500)
})

export default {
  fetch: app.fetch,

  /**
   * Cron dispatch.
   *
   * Both triggers arrive at this one handler, so it switches on the cron
   * expression. These must stay in sync with `[triggers].crons` in wrangler.toml.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Awaited, not waitUntil'd: a scheduled invocation already lives until its
    // promise settles, and detaching the work lets the runtime tear down mid-sync.
    switch (event.cron) {
      case '*/15 * * * *':
        await syncMonierate(env)
        break
      case '0 7 * * 1-5':
        await syncCbn(env)
        break
      default:
        console.error(`scheduled: no handler for cron expression "${event.cron}"`)
    }
  },
} satisfies ExportedHandler<Env>
