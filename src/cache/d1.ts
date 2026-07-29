import type { Env, Market, RateObservation } from '../types/rates'

/**
 * Column order for `rate_daily`. Shared with scripts/backfill-cbn.ts so the
 * generated SQL and the Worker's prepared statements cannot drift apart.
 */
export const DAILY_COLUMNS = [
  'source',
  'currency',
  'market',
  'rate_date',
  'bid',
  'ask',
  'mid',
  'open',
  'high',
  'low',
  'close',
  'turnover',
  'deal_count',
  'provider_count',
  'updated_at',
] as const

export const DAILY_UPSERT_SQL =
  `INSERT OR REPLACE INTO rate_daily (${DAILY_COLUMNS.join(', ')}) ` +
  `VALUES (${DAILY_COLUMNS.map(() => '?').join(', ')})`

export type DailyRow = readonly [
  source: string,
  currency: string,
  market: string,
  rateDate: string,
  bid: number | null,
  ask: number | null,
  mid: number | null,
  open: number | null,
  high: number | null,
  low: number | null,
  close: number | null,
  turnover: number | null,
  dealCount: number | null,
  providerCount: number | null,
  updatedAt: number,
]

export function toDailyRow(
  obs: RateObservation,
  source: string,
  updatedAt: number,
): DailyRow | null {
  if (!obs.rateDate) return null
  return [
    source,
    obs.currency,
    obs.market,
    obs.rateDate,
    obs.bid,
    obs.ask,
    obs.mid,
    obs.open ?? null,
    obs.high ?? null,
    obs.low ?? null,
    obs.close ?? null,
    obs.turnover ?? null,
    obs.dealCount ?? null,
    obs.providerCount ?? null,
    updatedAt,
  ]
}

/**
 * Upsert daily rows. INSERT OR REPLACE against the composite primary key makes
 * this idempotent — re-running a cron or replaying a backfill overwrites rather
 * than duplicating.
 */
export async function upsertDaily(
  env: Env,
  observations: readonly RateObservation[],
  source: string,
  updatedAt: number,
): Promise<number> {
  const rows = observations
    .map((o) => toDailyRow(o, source, updatedAt))
    .filter((r): r is DailyRow => r !== null)
  if (rows.length === 0) return 0

  const stmt = env.RATES_DB.prepare(DAILY_UPSERT_SQL)
  await env.RATES_DB.batch(rows.map((r) => stmt.bind(...r)))
  return rows.length
}

const SNAPSHOT_INSERT_SQL =
  'INSERT INTO rate_snapshots (source, currency, market, bid, ask, mid, provider_count, fetched_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

/** Append intraday observations. Append-only by design; pruned on the daily cron. */
export async function insertSnapshots(
  env: Env,
  observations: readonly RateObservation[],
  source: string,
  fetchedAt: number,
): Promise<number> {
  if (observations.length === 0) return 0

  const stmt = env.RATES_DB.prepare(SNAPSHOT_INSERT_SQL)
  await env.RATES_DB.batch(
    observations.map((o) =>
      stmt.bind(
        source,
        o.currency,
        o.market,
        o.bid,
        o.ask,
        o.mid,
        o.providerCount ?? null,
        fetchedAt,
      ),
    ),
  )
  return observations.length
}

/**
 * Drop intraday snapshots older than `days`.
 *
 * The daily roll-up has already condensed them into rate_daily, so nothing is
 * lost — this just stops an append-only table growing without bound
 * (~576 rows/day at 15-minute cadence across 6 tickers).
 */
export async function pruneSnapshots(env: Env, days = 30): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400
  const result = await env.RATES_DB.prepare(
    'DELETE FROM rate_snapshots WHERE fetched_at < ?',
  )
    .bind(cutoff)
    .run()
  return result.meta.changes ?? 0
}

export interface DailySeriesRow {
  rate_date: string
  bid: number | null
  ask: number | null
  mid: number | null
}

/**
 * Read a daily series for one currency and market.
 *
 * Ascending by date so trend maths can read the ends of the array directly.
 * Only ever called from /v1/rates/history — never from /v1/rates, which is a
 * single KV read.
 */
export async function getDailySeries(
  env: Env,
  currency: string,
  market: Market,
  days: number,
): Promise<DailySeriesRow[]> {
  const { results } = await env.RATES_DB.prepare(
    `SELECT rate_date, bid, ask, mid
       FROM rate_daily
      WHERE currency = ? AND market = ?
        AND rate_date >= date('now', ?)
      ORDER BY rate_date ASC`,
  )
    .bind(currency, market, `-${days} days`)
    .all<DailySeriesRow>()

  return results ?? []
}

export interface LatestOfficialRow {
  currency: string
  rate_date: string
  bid: number | null
  ask: number | null
  mid: number | null
  high: number | null
  low: number | null
  close: number | null
  turnover: number | null
  deal_count: number | null
}

/**
 * Each currency's most recent official row from D1.
 *
 * A fallback for `rebuild-payload` when the `latest:cbn` KV payload is absent.
 * That happens on a fresh deploy — the CBN cron only runs weekdays at 07:00 UTC,
 * so without this the API would serve `official: null` for every currency until
 * the next weekday morning, despite 51k backfilled rows sitting right here. It
 * also covers KV loss generally.
 *
 * Still not on the request path: this runs in the cron, which writes the result
 * into the served KV payload.
 *
 * `GROUP BY` with bare columns is relying on SQLite's documented min/max
 * optimisation — with `MAX(rate_date)` the other bare columns come from the
 * matching row. This is SQLite-specific behaviour, and D1 is SQLite.
 */
export async function getLatestOfficialRates(env: Env): Promise<LatestOfficialRow[]> {
  const { results } = await env.RATES_DB.prepare(
    `SELECT currency, MAX(rate_date) AS rate_date, bid, ask, mid,
            high, low, close, turnover, deal_count
       FROM rate_daily
      WHERE market = 'official' AND mid IS NOT NULL
      GROUP BY currency`,
  ).all<LatestOfficialRow>()

  return results ?? []
}

/**
 * Roll intraday snapshots for a UTC day into a single daily row per
 * currency/market, so /history has a parallel series to read once the 15-minute
 * sync has been running.
 */
export async function rollUpSnapshots(
  env: Env,
  source: string,
  rateDate: string,
): Promise<number> {
  const result = await env.RATES_DB.prepare(
    `INSERT OR REPLACE INTO rate_daily
       (source, currency, market, rate_date, bid, ask, mid, open, high, low, close, provider_count, updated_at)
     SELECT ?, currency, market, ?,
            AVG(bid), AVG(ask), AVG(mid),
            NULL,
            MAX(mid), MIN(mid),
            NULL,
            CAST(ROUND(AVG(provider_count)) AS INTEGER),
            unixepoch()
       FROM rate_snapshots
      WHERE source = ?
        AND date(fetched_at, 'unixepoch') = ?
      GROUP BY currency, market`,
  )
    .bind(source, rateDate, source, rateDate)
    .run()

  return result.meta.changes ?? 0
}
