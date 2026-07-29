/**
 * One-off Monierate parallel/street history backfill. READY TO RUN — NOT YET RUN.
 *
 * Deferred at launch by decision: /v1/rates/history ships with the 24-year CBN
 * official series, which is free. Run this only if `?market=parallel` shows real
 * usage, because unlike everything else in this repo it costs real money.
 *
 * ## Why this endpoint
 *
 * `rates/historical.json` — 1 unit per *year* of range, and therefore cheap — is
 * deprecated: "the underlying rate series backing this endpoint is no longer
 * maintained and returns no recent data." Its successors bill per row:
 * `pairs/{pair}/history` meters `rate_quote` **per daily candle returned**, at a
 * confirmed NGN 10 per unit. There is no cheaper path to this data.
 *
 * ## Cost
 *
 * At maximum available depth, roughly 4,850 candles ≈ NGN 48,500. Coverage starts
 * per pair, so "3 years" does not exist for most:
 *
 *   usdtngn 2023-09-11 | usdngn, eurngn 2024-05-22 | usdcngn 2024-09-24
 *   gbpngn 2024-10-08  | cadngn 2024-10-11        | aed/cny/zar/xof/xaf 2026-06-30
 *
 * ## Safety
 *
 * Dry-run by default: it prints an estimate and spends nothing. `--execute` is
 * required to spend. During execution it enforces a NGN budget, tracks the real
 * balance from `_meta.billing.wallet_balance_after`, and appends SQL to disk after
 * every page so a crash never loses data that has already been paid for.
 *
 *   npm run backfill:monierate                                  # estimate only
 *   npm run backfill:monierate -- --execute --budget-ngn=10000  # spend, capped
 *   npm run backfill:monierate:apply                            # write to D1
 *
 * Flags:
 *   --execute            Actually spend. Without it, nothing is charged.
 *   --budget-ngn=N       Hard NGN ceiling for the run (required with --execute).
 *   --from=YYYY-MM-DD    Earliest date to request (default: each pair's start).
 *   --to=YYYY-MM-DD      Latest date (default: yesterday UTC).
 *   --tickers=a,b        Restrict to these tickers.
 *   --limit=N            Candles per page, 1-500 (default 100).
 *   --out=PATH           Output SQL (default .backfill/monierate.sql).
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { DAILY_COLUMNS } from '../src/cache/d1'
import { RATE_QUOTE_COST_NGN } from '../src/collectors/monierate'
import { MONIERATE_CURRENCIES } from '../src/config/currencies'
import { readFile } from 'node:fs/promises'

const BASE = 'https://api.monierate.com/core'
const MONIERATE_SOURCE = 'monierate'

/** Documented first-candle dates, from Monierate's Pairs Historical Coverage. */
const COVERAGE_START: Readonly<Record<string, string>> = {
  usdtngn: '2023-09-11',
  usdngn: '2024-05-22',
  eurngn: '2024-05-22',
  usdcngn: '2024-09-24',
  gbpngn: '2024-10-08',
  cadngn: '2024-10-11',
  aedngn: '2026-06-30',
  cnyngn: '2026-06-30',
  zarngn: '2026-06-30',
  xofngn: '2026-06-30',
  xafngn: '2026-06-30',
}

interface Candle {
  date?: string
  open?: number
  high?: number
  low?: number
  close?: number
  avg_composite_rate?: number
}

interface HistoryEnvelope {
  status?: string
  message?: string
  data?: {
    total?: number
    count?: number
    page?: number
    limit?: number
    pair?: string
    entries?: Candle[]
  }
  _meta?: { billing?: { cost?: number; units?: number; wallet_balance_after?: number } }
}

interface Options {
  execute: boolean
  budgetNgn: number | null
  from: string | null
  to: string
  tickers: string[] | null
  limit: number
  out: string
}

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    execute: argv.includes('--execute'),
    budgetNgn: null,
    from: null,
    to: yesterdayUtc(),
    tickers: null,
    limit: 100,
    out: '.backfill/monierate.sql',
  }

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=', 2)
    if (!value) continue
    if (key === 'budget-ngn') {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) throw new Error('--budget-ngn must be a positive number')
      opts.budgetNgn = n
    } else if (key === 'from' || key === 'to') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--${key} must be YYYY-MM-DD`)
      if (key === 'from') opts.from = value
      else opts.to = value
    } else if (key === 'tickers') {
      opts.tickers = value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    } else if (key === 'limit') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('--limit must be 1..500')
      opts.limit = n
    } else if (key === 'out') {
      opts.out = value
    }
  }

  return opts
}

async function loadApiKey(): Promise<string> {
  const fromEnv = process.env.MONIERATE_API_KEY
  if (fromEnv) return fromEnv
  const raw = await readFile('.dev.vars', 'utf8').catch(() => '')
  const match = /^MONIERATE_API_KEY=(.+)$/m.exec(raw)
  if (match?.[1]) return match[1].trim()
  throw new Error('MONIERATE_API_KEY not found in the environment or .dev.vars')
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return ms < 0 ? 0 : Math.floor(ms / 86_400_000) + 1
}

function lit(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * One SQL tuple per candle.
 *
 * These candles are OHLC of Monierate's *composite* rate — a mid, with no bid/ask
 * — so those two columns are null. `avg_composite_rate` is preferred for `mid`
 * over `close`: it represents the whole day rather than its final tick, which
 * matches how the live collector aggregates.
 */
function toValuesTuple(
  candle: Candle,
  currency: string,
  market: string,
  updatedAt: number,
): string | null {
  if (!candle.date) return null
  const mid = candle.avg_composite_rate ?? candle.close ?? null
  if (mid === null || !Number.isFinite(mid) || mid <= 0) return null

  const values: (string | number | null)[] = [
    MONIERATE_SOURCE,
    currency,
    market,
    candle.date,
    null, // bid — composite candles are one-sided
    null, // ask
    mid,
    candle.open ?? null,
    candle.high ?? null,
    candle.low ?? null,
    candle.close ?? null,
    null, // turnover — NFEM only
    null, // deal_count
    null, // provider_count — not reported per candle
    updatedAt,
  ]
  return `(${values.map(lit).join(', ')})`
}

interface Target {
  ticker: string
  currency: string
  market: string
  start: string
  estimatedCandles: number
}

function buildTargets(opts: Options): Target[] {
  const targets: Target[] = []

  for (const def of MONIERATE_CURRENCIES) {
    if (opts.tickers && !opts.tickers.includes(def.ticker)) continue
    if (!def.monierateMarket) continue

    const coverageStart = COVERAGE_START[def.ticker]
    if (!coverageStart) {
      console.warn(`  skipping ${def.ticker}: no documented coverage start date`)
      continue
    }

    // Never request before the pair exists — those rows are free but pointless.
    const start = opts.from && opts.from > coverageStart ? opts.from : coverageStart
    if (start > opts.to) continue

    targets.push({
      ticker: def.ticker,
      currency: def.code,
      market: def.monierateMarket,
      start,
      estimatedCandles: daysBetween(start, opts.to),
    })
  }

  return targets
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const targets = buildTargets(opts)

  if (targets.length === 0) throw new Error('no tickers to back-fill')

  const totalCandles = targets.reduce((sum, t) => sum + t.estimatedCandles, 0)
  const estimateNgn = totalCandles * RATE_QUOTE_COST_NGN

  console.log('\nMonierate history backfill')
  console.log(`  range end:      ${opts.to} (candles cover completed days only)`)
  console.log(`  price per row:  NGN ${RATE_QUOTE_COST_NGN}`)
  console.log()
  console.log(
    `  ${'TICKER'.padEnd(10)}${'CUR'.padEnd(6)}${'MARKET'.padEnd(15)}${'FROM'.padEnd(13)}${'~ROWS'.padStart(7)}${'~NGN'.padStart(9)}`,
  )
  for (const t of targets) {
    console.log(
      `  ${t.ticker.padEnd(10)}${t.currency.padEnd(6)}${t.market.padEnd(15)}${t.start.padEnd(13)}` +
        `${String(t.estimatedCandles).padStart(7)}${String(t.estimatedCandles * RATE_QUOTE_COST_NGN).padStart(9)}`,
    )
  }
  console.log(
    `\n  UPPER BOUND: ${totalCandles} rows, NGN ${estimateNgn.toLocaleString('en-US')}. ` +
      'Actual will be lower — gaps and non-trading days return no candle and cost nothing.',
  )

  if (!opts.execute) {
    console.log('\n  DRY RUN — nothing was charged and no request was made.')
    console.log('  To spend, re-run with:  --execute --budget-ngn=<ceiling>')
    return
  }

  if (opts.budgetNgn === null) {
    throw new Error('--budget-ngn is required with --execute, as a spend ceiling')
  }

  const apiKey = await loadApiKey()
  const outPath = resolve(process.cwd(), opts.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(
    outPath,
    '-- Generated by scripts/backfill-monierate.ts — do not edit by hand.\n' +
      '-- Idempotent: INSERT OR REPLACE against the rate_daily composite primary key.\n\n',
    'utf8',
  )

  const insertHead = `INSERT OR REPLACE INTO rate_daily (${DAILY_COLUMNS.join(', ')}) VALUES`
  const updatedAt = Math.floor(Date.now() / 1000)

  let spentNgn = 0
  let rowsWritten = 0
  let walletNgn: number | null = null

  for (const target of targets) {
    let page = 1

    for (;;) {
      // The docs require the wallet to cover the full page size before the call
      // runs, so shrink the page as the budget tightens rather than 402-ing.
      const affordable = Math.floor((opts.budgetNgn - spentNgn) / RATE_QUOTE_COST_NGN)
      if (affordable < 1) {
        console.warn(
          `\n  BUDGET REACHED: NGN ${spentNgn} of ${opts.budgetNgn} spent. ` +
            `Stopping at ${target.ticker} page ${page}. Everything already fetched is in ${opts.out}.`,
        )
        break
      }
      const limit = Math.min(opts.limit, affordable)

      const url =
        `${BASE}/pairs/${encodeURIComponent(target.ticker)}/history` +
        `?start_date=${target.start}&end_date=${opts.to}&page=${page}&limit=${limit}`

      const res = await fetch(url, {
        headers: { api_key: apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()

      if (!res.ok) {
        console.error(`  ${target.ticker} page ${page}: HTTP ${res.status} — ${text.slice(0, 200)}`)
        break
      }

      const body = JSON.parse(text) as HistoryEnvelope
      const entries = body.data?.entries ?? []

      const cost = body._meta?.billing?.cost
      if (typeof cost === 'number') spentNgn += cost
      else spentNgn += entries.length * RATE_QUOTE_COST_NGN // conservative fallback
      if (typeof body._meta?.billing?.wallet_balance_after === 'number') {
        walletNgn = body._meta.billing.wallet_balance_after
      }

      if (entries.length === 0) break

      const tuples = entries
        .map((c) => toValuesTuple(c, target.currency, target.market, updatedAt))
        .filter((t): t is string => t !== null)

      // Append after every page: these rows are already paid for, and a crash must
      // not throw away money.
      if (tuples.length > 0) {
        await appendFile(outPath, `${insertHead}\n${tuples.join(',\n')};\n\n`, 'utf8')
        rowsWritten += tuples.length
      }

      console.log(
        `  ${target.ticker} page ${page}: ${entries.length} candle(s), ` +
          `NGN ${spentNgn} spent` +
          (walletNgn !== null ? `, wallet NGN ${walletNgn}` : ''),
      )

      const total = body.data?.total ?? 0
      if (page * limit >= total) break
      page++
    }

    if (spentNgn >= opts.budgetNgn) break
  }

  console.log(`\n  Wrote ${rowsWritten} row(s) to ${opts.out}`)
  console.log(`  Spent NGN ${spentNgn}${walletNgn !== null ? `, wallet now NGN ${walletNgn}` : ''}`)
  console.log('\n  Apply with:')
  console.log('    npm run backfill:monierate:apply:local')
  console.log('    npm run backfill:monierate:apply')
}

main().catch((err: unknown) => {
  console.error('\nbackfill failed:', err)
  process.exit(1)
})
