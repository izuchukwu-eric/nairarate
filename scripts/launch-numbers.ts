/**
 * Print current live figures for the launch post.
 *
 * Run this immediately before posting. Rates move daily, and a stale spread in a
 * post whose entire claim is rate accuracy is the worst available own-goal.
 *
 *   npm run launch:numbers
 *
 * Freshness comes from the free /health endpoint. The rate figures come from the
 * operator's own KV copy of the served payload, because /v1/rates is paid — the
 * namespace id is read from wrangler.toml so there is nothing to pass in.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ORIGIN =
  process.argv.find((a) => a.startsWith('--url='))?.split('=', 2)[1] ?? 'https://nairarate.dev'

interface Quote {
  mid: number | null
  provider_count?: number
  updated_at: string
}

interface Rates {
  timestamp: string
  confidence: string
  warnings?: string[]
  rates: Record<
    string,
    { official: Quote | null; parallel: Quote | null; crypto_street: Quote | null }
  >
  spreads: Record<string, Record<string, number | null>>
  trend_7d: Record<string, Record<string, string | null>>
}

async function kvNamespaceId(): Promise<string> {
  const toml = await readFile('wrangler.toml', 'utf8')
  const block = /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/.exec(toml)
  if (!block?.[1]) throw new Error('could not find the RATES_KV namespace id in wrangler.toml')
  return block[1]
}

async function servedPayload(): Promise<Rates> {
  const override = process.env.LATEST_RATES_JSON
  if (override) return JSON.parse(override) as Rates

  const id = await kvNamespaceId()
  const { stdout } = await execFileAsync(
    'npx',
    ['wrangler', 'kv', 'key', 'get', `--namespace-id=${id}`, '--remote', 'latest:rates'],
    { maxBuffer: 20 * 1024 * 1024 },
  )
  // wrangler prints the raw value; take the first JSON object in case of banners.
  const start = stdout.indexOf('{')
  if (start === -1) throw new Error(`no JSON in wrangler output: ${stdout.slice(0, 200)}`)
  return JSON.parse(stdout.slice(start)) as Rates
}

function n(v: number | null | undefined): string {
  return v === null || v === undefined
    ? '—'
    : `₦${v.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
}

/** 2dp, for prose. The 4dp figures above are for reconciliation, not for a post. */
function money(v: number | null | undefined): string {
  return v === null || v === undefined
    ? '—'
    : `₦${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

async function main(): Promise<void> {
  const health = (await (await fetch(`${ORIGIN}/health`)).json()) as {
    status: string
    sources: Record<string, { age_minutes: number | null; healthy: boolean }>
  }

  console.log(`\n  ${ORIGIN} — pulled ${new Date().toISOString()}`)
  console.log(`  health: ${health.status}`)
  for (const [k, v] of Object.entries(health.sources)) {
    console.log(`    ${k.padEnd(10)} age ${String(v.age_minutes)}min  healthy=${v.healthy}`)
  }
  if (health.status !== 'ok') {
    console.log('\n  *** /health is not ok — do not post until it is. ***')
  }

  const d = await servedPayload()
  const usd = d.rates['USD']
  const s = d.spreads['USD'] ?? {}

  console.log(`\n  payload ${d.timestamp}   confidence ${d.confidence}`)
  if (d.warnings?.length) for (const w of d.warnings) console.log(`  warning: ${w}`)

  console.log('\n  -- figures --')
  console.log(`  USD official   ${n(usd?.official?.mid)}   (CBN, ${usd?.official?.updated_at.slice(0, 10)})`)
  console.log(`  USD parallel   ${n(usd?.parallel?.mid)}   ${usd?.parallel?.provider_count} providers`)
  console.log(`  USDT street    ${n(d.rates['USDT']?.crypto_street?.mid)}`)
  console.log(`  USDC street    ${n(d.rates['USDC']?.crypto_street?.mid)}`)
  console.log(`  spread         ${pct(s['parallel_vs_official_pct'])}  parallel vs official`)
  console.log(`                 ${pct(s['usdt_vs_official_pct'])}  USDT vs official`)
  console.log(`  trend_7d USD   ${JSON.stringify(d.trend_7d['USD'])}`)

  const all = Object.entries(d.spreads)
    .map(([c, v]) => [c, v['parallel_vs_official_pct']] as const)
    .filter((x): x is readonly [string, number] => typeof x[1] === 'number')
    .sort((a, b) => b[1] - a[1])
  console.log(`\n  all spreads:   ${all.map(([c, v]) => `${c} ${pct(v)}`).join(', ')}`)

  console.log('\n  -- paste-ready --')
  console.log(
    `  Right now: official ${money(usd?.official?.mid)}, parallel ${money(usd?.parallel?.mid)}, ` +
      `USDT ${money(d.rates['USDT']?.crypto_street?.mid)}.`,
  )
  console.log(
    `  A ${pct(s['parallel_vs_official_pct']).replace('+', '')} spread that no mainstream ` +
      'FX API will show you.\n',
  )
}

main().catch((e: unknown) => {
  console.error(`\n  launch:numbers failed: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
