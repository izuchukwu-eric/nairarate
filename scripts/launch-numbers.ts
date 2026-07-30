/**
 * Print current live figures for the launch post.
 *
 * Run this immediately before posting. Rates move daily, and a stale spread in a
 * post whose entire claim is rate accuracy is the worst available own-goal.
 *
 *   npm run launch:numbers
 */

const ORIGIN = process.argv.find((a) => a.startsWith('--url='))?.split('=', 2)[1] ?? 'https://nairarate.dev'

interface Quote { mid: number | null; provider_count?: number; updated_at: string }
interface Rates {
  timestamp: string
  confidence: string
  rates: Record<string, { official: Quote | null; parallel: Quote | null; crypto_street: Quote | null }>
  spreads: Record<string, Record<string, number | null>>
  trend_7d: Record<string, Record<string, string | null>>
}

async function main(): Promise<void> {
  // /health is free and proves freshness; the figures come from the operator's KV
  // copy via wrangler, since /v1/rates is paid.
  const health = (await (await fetch(`${ORIGIN}/health`)).json()) as {
    status: string
    sources: Record<string, { age_minutes: number | null; healthy: boolean }>
  }

  console.log(`\n  ${ORIGIN}  —  ${new Date().toISOString()}`)
  console.log(`  health: ${health.status}`)
  for (const [k, v] of Object.entries(health.sources)) {
    console.log(`    ${k.padEnd(10)} age ${String(v.age_minutes)}min  healthy=${v.healthy}`)
  }

  const raw = process.env.LATEST_RATES_JSON
  if (!raw) {
    console.log(
      '\n  For the rate figures, pipe the served payload in:\n' +
        '    LATEST_RATES_JSON="$(npx wrangler kv key get --namespace-id=<id> --remote latest:rates)" \\\n' +
        '      npm run launch:numbers\n',
    )
    return
  }

  const d = JSON.parse(raw) as Rates
  const usd = d.rates['USD']!
  console.log(`\n  payload ${d.timestamp}  confidence ${d.confidence}`)
  console.log(`  USD official  N${usd.official?.mid}  (${usd.official?.updated_at.slice(0, 10)})`)
  console.log(`  USD parallel  N${usd.parallel?.mid}  ${usd.parallel?.provider_count} providers`)
  console.log(`  USDT street   N${d.rates['USDT']?.crypto_street?.mid}`)
  console.log(`  USDC street   N${d.rates['USDC']?.crypto_street?.mid}`)
  console.log(`  spread        ${d.spreads['USD']?.['parallel_vs_official_pct']}%`)
  console.log(`  trend_7d USD  ${JSON.stringify(d.trend_7d['USD'])}`)
  console.log('\n  Paste these into LAUNCH.md before posting.\n')
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
