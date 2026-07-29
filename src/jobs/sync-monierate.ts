import { insertSnapshots, rollUpSnapshots } from '../cache/d1'
import {
  getWalletBalanceNgn,
  markSourceError,
  markSourceOk,
  putMonieratePayload,
  putWalletBalanceNgn,
} from '../cache/kv'
import {
  MAX_FALLBACK_CALLS,
  RATE_QUOTE_COST_NGN,
  collectMonierate,
  toSnapshotObservations,
} from '../collectors/monierate'
import { rebuildRatesPayload } from './rebuild-payload'
import type { Env } from '../types/rates'

/** Today in UTC, 'YYYY-MM-DD'. */
function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Minimum wallet balance, NGN, before billable fallbacks are switched off.
 *
 * NGN 500 is ~50 `rate_quote` calls. At the per-run cap of 2 that is roughly 25
 * runs — about six hours of 15-minute cron headroom, enough to notice and top up.
 * Below it the sync still runs in full on the free platforms.json path; only the
 * billable fallback is withheld, so coverage degrades visibly in `warnings`
 * rather than the wallet emptying and every later sync 402-ing.
 */
export const WALLET_FLOOR_NGN = 500

/**
 * Monierate sync — every 15 minutes.
 *
 * Writes to KV only on success. A failed run deliberately leaves `latest:monierate`
 * untouched: stale rates are useful to an agent mid-task, an empty payload is not.
 */
export async function syncMonierate(env: Env): Promise<void> {
  const now = new Date()

  if (!env.MONIERATE_API_KEY) {
    await markSourceError(env, 'monierate', new Error('MONIERATE_API_KEY is not set'), now)
    console.error('sync-monierate: MONIERATE_API_KEY is not set; skipping')
    return
  }

  // Gate billable fallbacks on the last observed balance. Unknown (never made a
  // billable call) is permitted — that is the normal steady state, since the free
  // platforms.json path covers everything.
  const walletBefore = await getWalletBalanceNgn(env)
  const allowFallbacks = walletBefore === null || walletBefore >= WALLET_FLOOR_NGN

  if (!allowFallbacks) {
    console.warn(
      `sync-monierate: wallet balance NGN ${walletBefore} is below the NGN ${WALLET_FLOOR_NGN} ` +
        `floor (~${Math.floor((walletBefore ?? 0) / RATE_QUOTE_COST_NGN)} calls left). ` +
        'Billable fallbacks disabled for this run; top up at https://account.monierate.com. ' +
        'Free platforms.json collection is unaffected.',
    )
  }

  try {
    const result = await collectMonierate(env.MONIERATE_API_KEY, { now, allowFallbacks })

    if (Object.keys(result.payload.rates).length === 0) {
      throw new Error(
        `no usable rates from any of ${result.aggregates.length} ticker(s); ` +
          `failures: ${result.failed.map((f) => `${f.ticker} (${f.error})`).join('; ') || 'none'}`,
      )
    }

    if (result.walletNgn !== null) {
      await putWalletBalanceNgn(env, result.walletNgn)
      if (result.walletNgn < WALLET_FLOOR_NGN) {
        console.warn(
          `sync-monierate: wallet balance now NGN ${result.walletNgn}, below the ` +
            `NGN ${WALLET_FLOOR_NGN} floor. Top up at https://account.monierate.com.`,
        )
      }
    }

    await putMonieratePayload(env, result.payload)
    await markSourceOk(env, 'monierate', now)

    const observations = toSnapshotObservations(result.payload)
    const written = await insertSnapshots(
      env,
      observations,
      'monierate',
      result.payload.fetchedAt,
    )

    // Roll today's snapshots into the daily series on every run, not just once a
    // day. The composite primary key makes this idempotent, so each run simply
    // refreshes the partial row for today and the CBN cron finalises yesterday.
    //
    // Without this, a freshly deployed instance has no parallel daily rows at all
    // until the following 07:00 UTC — meaning /v1/rates/history?market=parallel
    // returns nothing, and trend_7d.parallel_direction stays null, for up to a day.
    let rolled = 0
    try {
      rolled = await rollUpSnapshots(env, 'monierate', todayUtc(now))
    } catch (err: unknown) {
      // Non-fatal: the served payload matters more than the history roll-up.
      console.error('sync-monierate: daily roll-up failed', err)
    }

    // Rebuild after the roll-up so trend_7d sees today's row in the same run.
    await rebuildRatesPayload(env, now)

    console.log(
      `sync-monierate: ${Object.keys(result.payload.rates).length} currencies, ` +
        `${written} snapshot(s), ${rolled} daily row(s) rolled, ` +
        `${result.fallbacksUsed}/${MAX_FALLBACK_CALLS} billable fallback(s)` +
        (result.failed.length > 0
          ? `, ${result.failed.length} ticker failure(s): ${result.failed.map((f) => f.ticker).join(', ')}`
          : ''),
    )
  } catch (err: unknown) {
    await markSourceError(env, 'monierate', err, now)
    console.error('sync-monierate: failed', err)
  }
}
