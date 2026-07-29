import type { Context } from 'hono'

import { getSourceStatus } from '../cache/kv'
import { ageMinutes, isCbnCurrent, isMonierateHealthy } from '../compute/confidence'
import type { Env, HealthResponse } from '../types/rates'

/**
 * GET /health — free, no payment.
 *
 * Exists so a caller can decide whether paying is worth it before they pay. That
 * only works if it reports honestly, so it reads the same KV meta keys the
 * confidence scorer uses and returns `degraded` whenever either source is behind.
 */
export async function healthHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const now = new Date()

  const [monierate, cbn] = await Promise.all([
    getSourceStatus(c.env, 'monierate'),
    getSourceStatus(c.env, 'cbn'),
  ])

  const monierateHealthy = isMonierateHealthy(monierate.lastOk, now)
  const cbnHealthy = isCbnCurrent(cbn.lastOk, now)

  const body: HealthResponse = {
    status: monierateHealthy && cbnHealthy ? 'ok' : 'degraded',
    sources: {
      monierate: {
        last_success: monierate.lastOk,
        age_minutes: ageMinutes(monierate.lastOk, now),
        healthy: monierateHealthy,
        last_error: monierate.lastError
          ? `${monierate.lastError.at}: ${monierate.lastError.message}`
          : null,
      },
      cbn: {
        last_success: cbn.lastOk,
        age_minutes: ageMinutes(cbn.lastOk, now),
        healthy: cbnHealthy,
        last_error: cbn.lastError ? `${cbn.lastError.at}: ${cbn.lastError.message}` : null,
      },
    },
  }

  // 200 either way: /health answering is itself the signal. A degraded body is
  // information, not a failure, and monitoring can key off `status`.
  return c.json(body, 200, { 'cache-control': 'no-store' })
}
