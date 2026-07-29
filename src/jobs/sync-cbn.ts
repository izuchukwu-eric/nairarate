import { pruneSnapshots, rollUpSnapshots, upsertDaily } from '../cache/d1'
import { markSourceError, markSourceOk, putCbnPayload } from '../cache/kv'
import { collectLatestCbn, toCbnPayload, toDailyObservations } from '../collectors/cbn'
import { rebuildRatesPayload } from './rebuild-payload'
import type { Env } from '../types/rates'

const SNAPSHOT_RETENTION_DAYS = 30

/** Yesterday in UTC, 'YYYY-MM-DD' — the day whose intraday rows are complete. */
function previousUtcDate(now: Date): string {
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * CBN sync — weekdays at 07:00 UTC (08:00 Lagos), plus daily housekeeping.
 *
 * Three jobs in one trigger because they all want to run once a day: fetch the
 * official rates, roll yesterday's intraday snapshots into the daily series so
 * /history has a parallel curve, and prune the snapshots table.
 *
 * The roll-up and prune run even if the CBN fetch fails — they are independent of
 * it, and skipping them would let rate_snapshots grow without bound during a CBN
 * outage.
 */
export async function syncCbn(env: Env): Promise<void> {
  const now = new Date()
  let cbnOk = false

  try {
    const result = await collectLatestCbn()

    if (result.rates.length === 0) {
      throw new Error(`CBN returned no usable rates for ${result.rateDate}`)
    }

    if (result.unmappedLabels.length > 0) {
      // Loud: an unmapped label means CBN renamed a currency and it would
      // otherwise silently disappear from the API.
      console.error(
        `sync-cbn: ${result.unmappedLabels.length} unmapped CBN label(s): ` +
          `${result.unmappedLabels.join(', ')}. Add them to CBN_LABEL_TO_CODE or ` +
          'CBN_IGNORED_LABELS in src/config/currencies.ts.',
      )
    }

    const fetchedAt = Math.floor(now.getTime() / 1000)
    await putCbnPayload(env, toCbnPayload(result, fetchedAt))
    await markSourceOk(env, 'cbn', now)
    cbnOk = true

    const written = await upsertDaily(env, toDailyObservations(result), 'cbn', fetchedAt)
    console.log(`sync-cbn: ${result.rateDate}, ${result.rates.length} currencies, ${written} daily row(s)`)
  } catch (err: unknown) {
    await markSourceError(env, 'cbn', err, now)
    console.error('sync-cbn: CBN fetch failed', err)
  }

  // Housekeeping, independent of the CBN fetch.
  try {
    const rolledDate = previousUtcDate(now)
    const rolled = await rollUpSnapshots(env, 'monierate', rolledDate)
    const pruned = await pruneSnapshots(env, SNAPSHOT_RETENTION_DAYS)
    console.log(
      `sync-cbn: rolled ${rolled} daily row(s) for ${rolledDate}, ` +
        `pruned ${pruned} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`,
    )
  } catch (err: unknown) {
    console.error('sync-cbn: housekeeping failed', err)
  }

  try {
    await rebuildRatesPayload(env, now)
  } catch (err: unknown) {
    console.error('sync-cbn: payload rebuild failed', err)
  }

  if (!cbnOk) {
    console.warn('sync-cbn: serving previous official rates; latest:cbn left untouched')
  }
}
