/**
 * Exercise the CBN collector against the live endpoints.
 *
 * Verifies the things that would otherwise fail silently in production: that
 * every registry currency actually resolves, that no upstream label is unmapped,
 * that the streaming scanner agrees with a full parse, and that the documented
 * NFEM/GetAllExchangeRates relationship still holds.
 *
 *   npm run probe:cbn
 */

import {
  collectLatestCbn,
  fetchAllNfemRates,
  fetchAllOfficialRates,
  fetchLatestOfficialRates,
  parseCbnDate,
} from '../src/collectors/cbn'
import { CBN_CURRENCIES } from '../src/config/currencies'

function heading(text: string): void {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`)
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  heading('1. Date parsing')
  const dateCases: [string, string | null][] = [
    ['July-27-2026', '2026-07-27'],
    ['January-3-2024', '2024-01-03'],
    ['2026-07-27', '2026-07-27'],
    ['2026-07-27T00:00:00', '2026-07-27'],
    ['Smarch-1-2026', null],
    ['', null],
  ]
  for (const [input, want] of dateCases) {
    const got = parseCbnDate(input)
    check(`${JSON.stringify(input)} -> ${want}`, got === want, got === want ? '' : `got ${got}`)
  }

  heading('2. Streaming scanner vs full parse')
  const [streamed, full] = await Promise.all([fetchLatestOfficialRates(), fetchAllOfficialRates()])

  // The streaming path must find every currency the full parse finds, and agree on
  // each one's latest row. This is the regression guard for the chunk-boundary bug
  // that silently truncated 11 currencies to 7.
  const latestByCode = new Map<string, (typeof full.rates)[number]>()
  for (const row of full.rates) {
    const held = latestByCode.get(row.currency)
    if (!held || row.rateDate > held.rateDate) latestByCode.set(row.currency, row)
  }

  check('streamed something', streamed.rates.length > 0, `${streamed.rates.length} currencies`)
  check(
    'streamed currency count matches full parse',
    streamed.rates.length === latestByCode.size,
    `streamed=${streamed.rates.length} full=${latestByCode.size}`,
  )

  const streamedByCode = new Map(streamed.rates.map((r) => [r.currency, r]))
  const missing = [...latestByCode.keys()].filter((code) => !streamedByCode.has(code))
  check('no currency dropped by the stream', missing.length === 0, missing.join(', ') || 'none dropped')

  let mismatch = 0
  for (const [code, row] of latestByCode) {
    const s = streamedByCode.get(code)
    if (!s || s.mid !== row.mid || s.rateDate !== row.rateDate) mismatch++
  }
  check('every latest mid and date agrees between the two paths', mismatch === 0, `${mismatch} mismatches`)

  const dates = [...new Set(streamed.rates.map((r) => r.rateDate))].sort()
  check(
    'per-currency dates captured (partial CBN publication tolerated)',
    dates.length >= 1,
    dates.length > 1 ? `spans ${dates.join(', ')} — laggards retained` : `all on ${dates[0]}`,
  )

  heading('3. Label coverage')
  check(
    'no unmapped labels in the full history',
    full.unmappedLabels.length === 0,
    full.unmappedLabels.length ? full.unmappedLabels.join(', ') : 'all labels resolved',
  )

  const presentCodes = new Set(full.rates.map((r) => r.currency))
  for (const c of CBN_CURRENCIES) {
    const n = full.rates.filter((r) => r.currency === c.code).length
    check(`${c.code} present upstream`, presentCodes.has(c.code), `${n} rows`)
  }

  heading('4. NFEM enrichment and the documented rate relationship')
  const nfem = await fetchAllNfemRates()
  check('NFEM returned rows', nfem.length > 0, `${nfem.length} rows`)

  const usdByDate = new Map(
    full.rates.filter((r) => r.currency === 'USD').map((r) => [r.rateDate, r]),
  )
  let checked = 0
  let askEqualsWavg = 0
  let centralOffsetHalf = 0
  for (const n of nfem.slice(0, 30)) {
    const e = usdByDate.get(n.rateDate)
    if (!e || e.ask === null) continue
    checked++
    if (Math.abs(e.ask - n.mid) < 1e-6) askEqualsWavg++
    if (Math.abs(e.mid - (n.mid - 0.5)) < 1e-6) centralOffsetHalf++
  }
  check(
    'ask (CBN sellingrate) === NFEM weightedAvgRate',
    checked > 0 && askEqualsWavg === checked,
    `${askEqualsWavg}/${checked}`,
  )
  check(
    'centralrate === weightedAvgRate - 0.50',
    checked > 0 && centralOffsetHalf === checked,
    `${centralOffsetHalf}/${checked}`,
  )

  heading('5. Collector output (what the cron will write)')
  const result = await collectLatestCbn()
  console.log(`  rateDate: ${result.rateDate}`)
  console.log(`  currencies: ${result.rates.length}`)
  console.log(`  unmapped: ${result.unmappedLabels.length ? result.unmappedLabels.join(', ') : 'none'}`)
  console.log()
  console.log(
    `  ${'CUR'.padEnd(5)}${'MID'.padStart(12)}${'BID'.padStart(12)}${'ASK'.padStart(12)}` +
      `${'HIGH'.padStart(10)}${'LOW'.padStart(10)}${'TURNOVER'.padStart(18)}`,
  )
  for (const r of [...result.rates].sort((a, b) => a.currency.localeCompare(b.currency))) {
    console.log(
      `  ${r.currency.padEnd(5)}${String(r.mid).padStart(12)}` +
        `${String(r.bid ?? '-').padStart(12)}${String(r.ask ?? '-').padStart(12)}` +
        `${String(r.high ?? '-').padStart(10)}${String(r.low ?? '-').padStart(10)}` +
        `${String(r.turnover ?? '-').padStart(18)}`,
    )
  }

  const usd = result.rates.find((r) => r.currency === 'USD')
  check('USD present', usd !== undefined)
  check('USD carries NFEM depth fields', usd?.high != null && usd?.turnover != null)
  check(
    'every registry currency present on the latest date',
    CBN_CURRENCIES.every((c) => result.rates.some((r) => r.currency === c.code)),
    CBN_CURRENCIES.filter((c) => !result.rates.some((r) => r.currency === c.code))
      .map((c) => c.code)
      .join(', ') || 'all present',
  )

  heading(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error('\nprobe failed:', err)
  process.exit(1)
})
