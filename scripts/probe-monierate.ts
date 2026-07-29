/**
 * Probe the live Monierate API before anything is built on top of it.
 *
 * Two things need settling that the documentation cannot settle:
 *
 *  1. `/rates/currencies.json` advertises 8 currencies (USD EUR GBP NGN CAD USDT
 *     USDC BTC), but the pair-coverage tables list live `aedngn`, `cnyngn`,
 *     `zarngn`, `xofngn`, `xafngn`, `chfngn`, `jpyngn`, `dkkngn` pairs from
 *     2026-06-30. Only a real call decides which is authoritative — and it decides
 *     whether five v1 currencies get a parallel series or stay official-only.
 *
 *  2. The `platforms.json` and `latest.json` response shapes are documented but
 *     unverified. The docs have already been wrong twice (historical.json is
 *     deprecated despite being presented as current; currencies.json is
 *     incomplete), so the shapes get captured from live responses, not trusted.
 *
 * Cost control: `platforms.json` is NOT a billable feature, so every ticker is
 * probed freely. `latest.json` meters `rate_quote` at NGN 10 per call (confirmed
 * from a live `_meta.billing` response, not from the docs, which publish no
 * price), so it is called at most twice and only with --latest. Confirmed
 * billable and skipped by default: pairs/list, pairs/detail, pairs/providers.
 *
 *   npm run probe:monierate              # free — platforms.json only
 *   npm run probe:monierate -- --latest  # adds 2 billable calls (NGN 20)
 */

import { readFile } from 'node:fs/promises'

import { collectLatestCbn } from '../src/collectors/cbn'
import { collectMonierate } from '../src/collectors/monierate'
import { MONIERATE_CURRENCIES } from '../src/config/currencies'

const BASE = 'https://api.monierate.com/core'

/** Every ticker the v1 registry might want, plus the extras the coverage tables list. */
const CANDIDATE_TICKERS = [
  // Confirmed by currencies.json
  'usdngn', 'eurngn', 'gbpngn', 'cadngn', 'usdtngn', 'usdcngn',
  // Listed in the pair-coverage tables but absent from currencies.json
  'aedngn', 'cnyngn', 'zarngn', 'xofngn', 'xafngn', 'chfngn', 'jpyngn', 'dkkngn',
  // CBN publishes SAR officially; no coverage-table entry, so this is a guess
  'sarngn',
  // Out of v1 scope, probed only to record what exists
  'audngn', 'ghsngn', 'kesngn',
] as const

interface PlatformEntry {
  code?: string
  rate_mode?: string
  buy?: number
  sell?: number
  last_updated?: number
}

interface Envelope<T> {
  status?: string
  message?: string
  data?: T
  _meta?: { billing?: Record<string, unknown> }
}

async function loadApiKey(): Promise<string> {
  const fromEnv = process.env.MONIERATE_API_KEY
  if (fromEnv) return fromEnv

  // Fall back to .dev.vars so the key never has to be passed on the command line.
  // Resolved from the project root, which is where npm scripts run.
  const raw = await readFile('.dev.vars', 'utf8').catch(() => '')
  const match = /^MONIERATE_API_KEY=(.+)$/m.exec(raw)
  if (match?.[1]) return match[1].trim()

  throw new Error('MONIERATE_API_KEY not found in the environment or .dev.vars')
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`)
}

async function call<T>(
  path: string,
  apiKey: string,
): Promise<{ status: number; body: Envelope<T> | { raw: string } }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { api_key: apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Envelope<T> }
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 300) } }
  }
}

interface TickerResult {
  ticker: string
  status: number
  platforms: number
  bestBuy: number | null
  bestSell: number | null
  midOfMids: number | null
  automated: number
  manual: number
  newestUpdate: number | null
  message: string
}

function summarisePlatforms(ticker: string, status: number, body: unknown): TickerResult {
  const envelope = body as Envelope<{ platforms?: PlatformEntry[]; size?: number }>
  const platforms = envelope.data?.platforms ?? []

  const buys = platforms.map((p) => p.buy).filter((n): n is number => typeof n === 'number' && n > 0)
  const sells = platforms.map((p) => p.sell).filter((n): n is number => typeof n === 'number' && n > 0)
  const updates = platforms
    .map((p) => p.last_updated)
    .filter((n): n is number => typeof n === 'number' && n > 0)

  // Mid of per-platform mids, which is what the collector will publish.
  const mids = platforms
    .filter((p) => typeof p.buy === 'number' && typeof p.sell === 'number')
    .map((p) => (p.buy! + p.sell!) / 2)

  return {
    ticker,
    status,
    platforms: platforms.length,
    bestBuy: buys.length ? Math.max(...buys) : null,
    bestSell: sells.length ? Math.min(...sells) : null,
    midOfMids: mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : null,
    automated: platforms.filter((p) => p.rate_mode === 'automated').length,
    manual: platforms.filter((p) => p.rate_mode !== 'automated').length,
    newestUpdate: updates.length ? Math.max(...updates) : null,
    message: String(envelope.message ?? ''),
  }
}

function fmt(n: number | null, dp = 2): string {
  return n === null ? '-' : n.toFixed(dp)
}

async function main(): Promise<void> {
  const apiKey = await loadApiKey()
  const wantLatest = process.argv.includes('--latest')

  heading('1. currencies.json — the advertised catalogue (free, no key)')
  const curRes = await fetch(`${BASE}/rates/currencies.json`, {
    signal: AbortSignal.timeout(30_000),
  })
  const curBody = (await curRes.json()) as Envelope<{ result?: Record<string, unknown> }>
  const advertised = Object.keys(curBody.data?.result ?? {})
  console.log(`  HTTP ${curRes.status} — ${advertised.length} currencies: ${advertised.join(', ')}`)

  heading('2. platforms.json across every candidate ticker (non-billable)')
  console.log(
    `  ${'TICKER'.padEnd(9)}${'HTTP'.padStart(5)}${'PLATS'.padStart(7)}${'AUTO'.padStart(6)}` +
      `${'MAN'.padStart(5)}${'BEST BUY'.padStart(12)}${'BEST SELL'.padStart(12)}${'MID'.padStart(12)}${'  MESSAGE'}`,
  )

  const results: TickerResult[] = []
  for (const ticker of CANDIDATE_TICKERS) {
    const { status, body } = await call(`/rates/platforms.json?ticker=${ticker}`, apiKey)
    const r = summarisePlatforms(ticker, status, body)
    results.push(r)
    console.log(
      `  ${r.ticker.padEnd(9)}${String(r.status).padStart(5)}${String(r.platforms).padStart(7)}` +
        `${String(r.automated).padStart(6)}${String(r.manual).padStart(5)}` +
        `${fmt(r.bestBuy).padStart(12)}${fmt(r.bestSell).padStart(12)}${fmt(r.midOfMids).padStart(12)}` +
        `  ${r.status === 200 ? '' : r.message}`,
    )
  }

  heading('3. Verdict on the currencies.json vs coverage-table contradiction')
  const live = results.filter((r) => r.status === 200 && r.platforms > 0)
  const empty = results.filter((r) => r.status === 200 && r.platforms === 0)
  const failed = results.filter((r) => r.status !== 200)

  console.log(`  Live with platforms quoting:  ${live.map((r) => r.ticker).join(', ') || 'none'}`)
  console.log(`  200 but zero platforms:       ${empty.map((r) => r.ticker).join(', ') || 'none'}`)
  console.log(`  Errored:                      ${failed.map((r) => `${r.ticker}(${r.status})`).join(', ') || 'none'}`)

  const beyondCatalogue = live.filter((r) => {
    const base = r.ticker.replace(/ngn$/, '').toUpperCase()
    return !advertised.includes(base)
  })
  console.log(
    `\n  Tickers live despite being absent from currencies.json: ` +
      `${beyondCatalogue.map((r) => r.ticker).join(', ') || 'none'}`,
  )
  console.log(
    beyondCatalogue.length > 0
      ? '  => currencies.json is an incomplete legacy catalogue. Registry parallel flags can be widened.'
      : '  => currencies.json is authoritative for platforms.json. Keep the official-only registry as built.',
  )

  heading('4. Raw platforms.json shape (first live ticker)')
  const firstLive = live[0]
  if (firstLive) {
    const { body } = await call(`/rates/platforms.json?ticker=${firstLive.ticker}`, apiKey)
    const envelope = body as Envelope<{ platforms?: PlatformEntry[]; size?: number }>
    console.log(`  ticker: ${firstLive.ticker}`)
    console.log(`  top-level keys: ${Object.keys(envelope).join(', ')}`)
    console.log(`  data keys: ${Object.keys(envelope.data ?? {}).join(', ')}`)
    const sample = envelope.data?.platforms?.slice(0, 3) ?? []
    console.log(`  first ${sample.length} platform entr(ies):`)
    for (const p of sample) console.log(`    ${JSON.stringify(p)}`)
    console.log(`  reported size: ${JSON.stringify(envelope.data?.size)}`)
    if (envelope._meta) console.log(`  _meta: ${JSON.stringify(envelope._meta)}`)
    else console.log('  _meta: absent (consistent with platforms.json being non-billable)')
  } else {
    console.log('  no live ticker to sample')
  }

  if (!wantLatest) {
    heading('5. latest.json — SKIPPED')
    console.log('  Billable at NGN 10/call. Re-run with `-- --latest` to capture its shape.')
  } else {
    heading('5. latest.json — 2 billable calls (NGN 20)')
    for (const path of [
      '/rates/latest.json?base=USD&quote=NGN&market=parallel',
      '/rates/latest.json?base=NGN&market=parallel',
    ]) {
      const { status, body } = await call(path, apiKey)
      const envelope = body as Envelope<Record<string, unknown>>
      console.log(`\n  GET ${path}`)
      console.log(`  HTTP ${status}`)
      console.log(`  ${JSON.stringify(envelope).slice(0, 700)}`)
      if (envelope._meta?.billing) {
        console.log(`  >>> ACTUAL BILLING: ${JSON.stringify(envelope._meta.billing)}`)
      }
    }
  }

  heading('6. The collector, end to end — screened aggregates vs CBN official')
  const collected = await collectMonierate(apiKey)
  const cbn = await collectLatestCbn()
  const officialByCode = new Map(cbn.rates.map((r) => [r.currency, r.mid]))

  console.log(
    `  ${'CUR'.padEnd(5)}${'MKT'.padEnd(15)}${'BID'.padStart(11)}${'ASK'.padStart(11)}${'MID'.padStart(11)}` +
      `${'N'.padStart(4)}${'OFFICIAL'.padStart(11)}${'VS OFF%'.padStart(9)}  DIAGNOSTICS`,
  )

  for (const def of MONIERATE_CURRENCIES) {
    const rate = collected.payload.rates[def.code]
    const agg = collected.aggregates.find((a) => a.ticker === def.ticker)
    const official = officialByCode.get(def.officialFrom ?? def.code) ?? null

    if (!rate) {
      console.log(`  ${def.code.padEnd(5)}${'(no quote)'.padEnd(15)}` + ' '.repeat(37) + `  ${JSON.stringify(agg?.diagnostics ?? {})}`)
      continue
    }

    const vsOfficial =
      official !== null && rate.mid !== null ? ((rate.mid - official) / official) * 100 : null

    console.log(
      `  ${def.code.padEnd(5)}${rate.market.padEnd(15)}` +
        `${fmt(rate.bid).padStart(11)}${fmt(rate.ask).padStart(11)}${fmt(rate.mid).padStart(11)}` +
        `${String(rate.providerCount).padStart(4)}${fmt(official).padStart(11)}` +
        `${(vsOfficial === null ? '-' : `${vsOfficial >= 0 ? '+' : ''}${vsOfficial.toFixed(2)}`).padStart(9)}` +
        `  raw=${agg?.diagnostics.raw} ref=${agg?.diagnostics.reference} 1side=${agg?.diagnostics.oneSided} outl=${agg?.diagnostics.outliers}`,
    )
  }

  console.log(`\n  failed tickers: ${collected.payload.failedTickers.join(', ') || 'none'}`)
  console.log(`  billable fallback calls used: ${collected.fallbacksUsed}`)

  heading('Done')
  console.log(`  ${live.length}/${CANDIDATE_TICKERS.length} candidate tickers are live with quotes.`)
  console.log(
    `  Billable calls this run: ${collected.fallbacksUsed + (wantLatest ? 2 : 0)} ` +
      `(NGN 10 each). platforms.json and CBN are free.`,
  )
}

main().catch((err: unknown) => {
  console.error('\nprobe failed:', err)
  process.exit(1)
})
