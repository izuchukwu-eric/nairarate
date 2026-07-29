/**
 * CBN official rate collector.
 *
 * The build spec described this as an HTML scrape of
 * cbn.gov.ng/rates/ExchRateByCurrency.html. That page is a Kendo UI grid with no
 * rate rows in its static HTML — but its script1.js reveals the JSON endpoints
 * the grid reads from, so there is no scraping and no parsing of markup here.
 *
 *   GET /api/GetAllNFEM_Rates      ~114 KB, USD only, daily, with market depth.
 *                                  weightedAvgRate is CBN's stated official rate.
 *   GET /api/GetAllExchangeRates   ~8 MB (1.7 MB gzipped), every currency,
 *                                  buying/central/selling, back to 2001-12-10.
 *
 * Neither accepts a filter parameter — `?currency=`, `?ratedate=`, `?top=` are
 * all ignored and return the full payload. So the daily sync streams the 8 MB
 * response and retains only each currency's most recent row, keeping peak memory
 * at a few dozen rows instead of a ~60 MB parsed object graph. The backfill
 * script, which runs locally, parses the whole thing.
 *
 * Latest rates are tracked per currency, not per date, because CBN publishes
 * partially: on 2026-07-28 seven currencies were out before the remaining four
 * followed. Filtering to a single newest date would drop the laggards from the API
 * entirely for hours despite a good previous-day rate existing.
 *
 * Verified relationship between the two feeds (checked across 8 consecutive
 * business days): for USD, `sellingrate` === NFEM `weightedAvgRate` exactly,
 * `centralrate` === weightedAvgRate - 0.50, `buyingrate` === weightedAvgRate - 1.00.
 * The ±₦0.50 band is a synthetic convention, so NFEM is preferred as USD's mid
 * and contributes the high/low/close/turnover fields no other currency has.
 */

import {
  CBN_CURRENCIES,
  resolveCbnLabel,
} from '../config/currencies'
import { repairBand } from '../compute/sanity'
import type { CbnPayload, CbnRate, RateObservation } from '../types/rates'

const NFEM_URL = 'https://www.cbn.gov.ng/api/GetAllNFEM_Rates'
const EXCHRATE_URL = 'https://www.cbn.gov.ng/api/GetAllExchangeRates'

const FETCH_TIMEOUT_MS = 25_000

export const CBN_OFFICIAL_SOURCE = 'CBN NFEM'

interface NfemRow {
  ratedate?: string
  weightedAvgRate?: string
  simpleAvgRate?: string
  highestrate?: string
  lowestrate?: string
  closingrate?: string
  nfeM_Total_Turnover?: string
  noOfDeals?: string
}

interface ExchRateRow {
  currency?: string
  ratedate?: string
  buyingrate?: string
  centralrate?: string
  sellingrate?: string
}

/** A normalised daily official observation, before it reaches D1 or KV. */
export interface CbnDailyRate {
  currency: string
  rateDate: string
  /** CBN's `buyingrate` — the low side. */
  bid: number | null
  /** CBN's `sellingrate` — the high side. */
  ask: number | null
  mid: number
  high: number | null
  low: number | null
  close: number | null
  turnover: number | null
  dealCount: number | null
}

export interface CbnCollectResult {
  /** Newest business date present upstream, 'YYYY-MM-DD'. */
  rateDate: string
  rates: CbnDailyRate[]
  unmappedLabels: string[]
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, string>> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
}

/**
 * CBN uses two date formats across the two endpoints:
 *   GetAllNFEM_Rates      'July-27-2026'
 *   GetAllExchangeRates   '2026-07-27'
 * Returns null rather than throwing so one malformed row cannot fail a sync.
 */
export function parseCbnDate(raw: string | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const named = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(value)
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()]
    if (!month) return null
    return `${named[3]}-${month}-${named[2]!.padStart(2, '0')}`
  }

  return null
}

function num(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

async function fetchJson(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`CBN ${url} returned HTTP ${res.status}`)
  return res
}

/**
 * Yield objects from a top-level JSON array without buffering the whole payload.
 *
 * Tracks string state and escapes so a brace inside a string value cannot
 * desynchronise the scan. Only complete objects are parsed, one at a time, so
 * peak memory is one row plus the current chunk.
 */
export async function* streamJsonArrayObjects<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) throw new Error('CBN response had no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  let buf = ''
  /**
   * How far into `buf` we have already scanned. Essential: `depth`, `inString` and
   * `start` persist across chunk boundaries, so re-scanning from 0 after appending
   * a chunk would re-count braces already counted and corrupt the parse.
   */
  let scanPos = 0
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      for (let i = scanPos; i < buf.length; i++) {
        const ch = buf[i]!

        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }

        if (ch === '"') {
          inString = true
        } else if (ch === '{') {
          if (depth === 0) start = i
          depth++
        } else if (ch === '}') {
          depth--
          if (depth === 0 && start !== -1) {
            yield JSON.parse(buf.slice(start, i + 1)) as T
            // Drop what we consumed and rebase the scan onto the remainder.
            buf = buf.slice(i + 1)
            i = -1
            scanPos = 0
            start = -1
          }
        }
      }

      if (depth === 0) {
        // Between objects: nothing retained, so drop the separators.
        buf = ''
        scanPos = 0
      } else {
        // Mid-object: keep the partial text and resume where this chunk ended.
        scanPos = buf.length
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// NFEM — USD official, with market depth
// ---------------------------------------------------------------------------

function nfemToDaily(row: NfemRow): CbnDailyRate | null {
  const rateDate = parseCbnDate(row.ratedate)
  const mid = num(row.weightedAvgRate)
  if (!rateDate || mid === null) return null

  return {
    currency: 'USD',
    rateDate,
    // NFEM publishes a single volume-weighted rate, not a two-sided quote.
    bid: null,
    ask: null,
    mid,
    high: num(row.highestrate),
    low: num(row.lowestrate),
    close: num(row.closingrate),
    turnover: num(row.nfeM_Total_Turnover),
    dealCount: num(row.noOfDeals),
  }
}

/** Every NFEM row. Small enough (~412 rows) to parse whole, even in a Worker. */
export async function fetchAllNfemRates(): Promise<CbnDailyRate[]> {
  const res = await fetchJson(NFEM_URL)
  const rows = (await res.json()) as NfemRow[]
  if (!Array.isArray(rows)) throw new Error('CBN NFEM payload was not an array')

  return rows
    .map(nfemToDaily)
    .filter((r): r is CbnDailyRate => r !== null)
    .sort((a, b) => (a.rateDate < b.rateDate ? 1 : -1))
}

// ---------------------------------------------------------------------------
// GetAllExchangeRates — every currency
// ---------------------------------------------------------------------------

const CBN_CODES: ReadonlySet<string> = new Set(CBN_CURRENCIES.map((c) => c.code))

function exchRateToDaily(row: ExchRateRow, code: string): CbnDailyRate | null {
  const rateDate = parseCbnDate(row.ratedate)
  const mid = num(row.centralrate)
  if (!rateDate || mid === null) return null

  // CBN's buyingrate is the LOW side and sellingrate the HIGH side — the opposite
  // orientation to Monierate's buy/sell, hence the bid/ask normalisation. The band
  // is also reconciled against mid: CBN publishes rows where buyingrate exceeds
  // sellingrate, and mid is the value we can actually trust.
  const band = repairBand(num(row.buyingrate), num(row.sellingrate), mid)

  return {
    currency: code,
    rateDate,
    bid: band.bid,
    ask: band.ask,
    mid,
    high: null,
    low: null,
    close: null,
    turnover: null,
    dealCount: null,
  }
}

/**
 * Stream GetAllExchangeRates and keep each currency's own most recent row.
 *
 * Deliberately per-currency rather than "every row on the newest date". CBN
 * publishes partially: on 2026-07-28 it had USD, EUR, GBP and four others out
 * before AED, CNY, ZAR and XOF followed. Filtering to the newest global date would
 * have dropped those four from the API entirely for hours, even though a perfectly
 * good previous-day rate existed. So each currency carries its own `rateDate` and
 * the caller sees a per-currency `updated_at`.
 *
 * Row order is not assumed — a row only replaces what we hold if it is newer for
 * that currency — so this is correct regardless of upstream ordering while holding
 * at most one row per currency.
 */
export async function fetchLatestOfficialRates(): Promise<CbnCollectResult> {
  const res = await fetchJson(EXCHRATE_URL)

  const byCurrency = new Map<string, CbnDailyRate>()
  const unmapped = new Set<string>()

  for await (const row of streamJsonArrayObjects<ExchRateRow>(res)) {
    const rateDate = parseCbnDate(row.ratedate)
    if (!rateDate) continue

    if (!row.currency) continue
    const resolved = resolveCbnLabel(row.currency)
    if (resolved.kind === 'unmapped') {
      unmapped.add(resolved.label)
      continue
    }
    if (resolved.kind === 'ignored' || !CBN_CODES.has(resolved.code)) continue

    const existing = byCurrency.get(resolved.code)
    if (existing && existing.rateDate >= rateDate) continue

    const daily = exchRateToDaily(row, resolved.code)
    if (daily) byCurrency.set(resolved.code, daily)
  }

  if (byCurrency.size === 0) {
    throw new Error('CBN exchange rates payload contained no usable rows')
  }

  const rates = [...byCurrency.values()]
  // The headline rateDate is the newest any currency reached.
  const newest = rates.reduce((max, r) => (r.rateDate > max ? r.rateDate : max), '')

  return {
    rateDate: newest,
    rates,
    unmappedLabels: [...unmapped],
  }
}

/**
 * Every currency, every date. Parses the full ~8 MB payload — intended for the
 * local backfill script, not the Worker.
 */
export async function fetchAllOfficialRates(): Promise<{
  rates: CbnDailyRate[]
  unmappedLabels: string[]
}> {
  const res = await fetchJson(EXCHRATE_URL)
  const rows = (await res.json()) as ExchRateRow[]
  if (!Array.isArray(rows)) throw new Error('CBN exchange rates payload was not an array')

  const rates: CbnDailyRate[] = []
  const unmapped = new Set<string>()

  for (const row of rows) {
    if (!row.currency) continue
    const resolved = resolveCbnLabel(row.currency)
    if (resolved.kind === 'unmapped') {
      unmapped.add(resolved.label)
      continue
    }
    if (resolved.kind === 'ignored' || !CBN_CODES.has(resolved.code)) continue

    const daily = exchRateToDaily(row, resolved.code)
    if (daily) rates.push(daily)
  }

  return { rates, unmappedLabels: [...unmapped] }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Overlay NFEM onto USD.
 *
 * NFEM's weighted average is CBN's own stated official rate, and it is the only
 * series carrying high/low/close/turnover. Where both feeds have USD for a date,
 * NFEM wins on `mid` and contributes the depth fields, while the two-sided
 * buying/selling band from GetAllExchangeRates is retained.
 */
export function mergeNfemIntoOfficial(
  official: readonly CbnDailyRate[],
  nfem: readonly CbnDailyRate[],
): CbnDailyRate[] {
  const nfemByDate = new Map(nfem.map((r) => [r.rateDate, r]))
  const seen = new Set<string>()
  const merged: CbnDailyRate[] = []

  for (const row of official) {
    if (row.currency !== 'USD') {
      merged.push(row)
      continue
    }
    seen.add(row.rateDate)
    const depth = nfemByDate.get(row.rateDate)
    merged.push(
      depth
        ? {
            ...row,
            mid: depth.mid,
            high: depth.high,
            low: depth.low,
            close: depth.close,
            turnover: depth.turnover,
            dealCount: depth.dealCount,
          }
        : row,
    )
  }

  // NFEM dates with no GetAllExchangeRates counterpart still belong in the series.
  for (const row of nfem) {
    if (!seen.has(row.rateDate)) merged.push(row)
  }

  return merged
}

// ---------------------------------------------------------------------------
// Collector entry point
// ---------------------------------------------------------------------------

/**
 * Fetch the latest official rates for every CBN currency.
 *
 * NFEM is fetched concurrently but treated as optional enrichment: if it fails,
 * USD falls back to the GetAllExchangeRates central rate rather than the whole
 * sync failing.
 */
export async function collectLatestCbn(): Promise<CbnCollectResult> {
  const [official, nfem] = await Promise.all([
    fetchLatestOfficialRates(),
    fetchAllNfemRates().catch((err: unknown) => {
      console.warn('cbn: NFEM enrichment failed, falling back to central rate', err)
      return [] as CbnDailyRate[]
    }),
  ])

  // Enrich USD in place. No date filtering: `official.rates` is already one row per
  // currency at that currency's own latest date, and NFEM only overlays the USD row
  // whose date it matches.
  return {
    ...official,
    rates: mergeNfemIntoOfficial(official.rates, nfem).filter((r) =>
      // Drop NFEM-only rows for dates older than the USD row we already hold; they
      // belong to the backfill, not to a "latest rates" payload.
      official.rates.some((o) => o.currency === r.currency && o.rateDate === r.rateDate),
    ),
  }
}

/** Shape a collector result for KV storage as `latest:cbn`. */
export function toCbnPayload(result: CbnCollectResult, fetchedAt: number): CbnPayload {
  const rates: Record<string, CbnRate> = {}

  for (const r of result.rates) {
    rates[r.currency] = {
      rateDate: r.rateDate,
      bid: r.bid,
      ask: r.ask,
      mid: r.mid,
      high: r.high,
      low: r.low,
      close: r.close,
      turnover: r.turnover,
      dealCount: r.dealCount,
    }
  }

  return {
    rateDate: result.rateDate,
    fetchedAt,
    rates,
    unmappedLabels: result.unmappedLabels,
  }
}

/** Shape a collector result for the `rate_daily` table. */
export function toDailyObservations(result: CbnCollectResult): RateObservation[] {
  return result.rates.map((r) => ({
    currency: r.currency,
    market: 'official' as const,
    bid: r.bid,
    ask: r.ask,
    mid: r.mid,
    rateDate: r.rateDate,
    high: r.high,
    low: r.low,
    close: r.close,
    turnover: r.turnover,
    dealCount: r.dealCount,
    providerCount: null,
  }))
}
