import type { Market } from '../types/rates'

/**
 * The v1 currency registry.
 *
 * Coverage is deliberately asymmetric — a currency can have an official source,
 * a parallel source, both, or (for the stablecoins) only a crypto street price.
 * Nothing here fabricates a series that no upstream actually publishes; a market
 * a currency does not carry comes back as `null` in the response.
 *
 * Coverage below is settled by live probing (scripts/probe-monierate.ts), not by
 * documentation. `/rates/currencies.json` advertises only 8 currencies and is an
 * incomplete legacy catalogue: `platforms.json` serves live quotes for aedngn,
 * cnyngn, zarngn, xofngn, xafngn, chfngn, jpyngn and dkkngn too.
 *
 * But a live ticker is not the same as a usable street rate. After excluding the
 * `cbn` and reference feeds that quote inside these pairs, the count of genuine
 * two-sided street quotes is what decides whether a parallel rate is published:
 *
 *   USD 43   USDT 16   USDC 15   EUR 7   GBP 7      -> solid
 *   CAD 2    ZAR 2                                  -> thin, published with count
 *   AED 1    CNY 1     XOF 1     XAF 1              -> single quote, count exposed
 *   CHF 0    JPY 0     DKK 0                        -> official only
 *   SAR      no pair at all (platforms.json 400)     -> official only
 *
 * CHF/JPY/DKK are confirmed twice: platforms.json returns nothing but reference
 * feeds, and latest.json answers 404 "No rates found" for DKK.
 */
export interface CurrencyDef {
  /** Response key and D1 `currency` value. */
  code: string
  name: string
  /** Monierate ticker against NGN, when a parallel/crypto series exists. */
  ticker: string | null
  /** Which market a Monierate series for this currency represents. */
  monierateMarket: Extract<Market, 'parallel' | 'crypto_street'> | null
  /** Whether CBN publishes an official rate for this currency. */
  cbnOfficial: boolean
  /**
   * Take the official rate from another currency's CBN series rather than a label
   * of this currency's own. Only XAF uses this: CBN publishes one unified "CFA"
   * series and no separate XAF label.
   */
  officialFrom?: string
  /** Surfaced in the response as `note` when present. */
  note?: string
}

export const CURRENCIES: readonly CurrencyDef[] = [
  // Full three-way coverage: official + parallel (+ stablecoin cross for USD).
  { code: 'USD', name: 'US Dollar', ticker: 'usdngn', monierateMarket: 'parallel', cbnOfficial: true },
  { code: 'EUR', name: 'Euro', ticker: 'eurngn', monierateMarket: 'parallel', cbnOfficial: true },
  { code: 'GBP', name: 'Pound Sterling', ticker: 'gbpngn', monierateMarket: 'parallel', cbnOfficial: true },

  // Parallel only — CBN publishes no official CAD rate.
  { code: 'CAD', name: 'Canadian Dollar', ticker: 'cadngn', monierateMarket: 'parallel', cbnOfficial: false },

  // Stablecoin street prices. USDC matters disproportionately here: x402 settles
  // in USDC on Base, so this is the rate our own callers are exposed to.
  { code: 'USDT', name: 'Tether USD', ticker: 'usdtngn', monierateMarket: 'crypto_street', cbnOfficial: false },
  { code: 'USDC', name: 'USD Coin', ticker: 'usdcngn', monierateMarket: 'crypto_street', cbnOfficial: false },

  // Official + thin parallel. Live pairs, but only 1-2 genuine street quotes each,
  // so `provider_count` in the response is doing real work here.
  { code: 'AED', name: 'UAE Dirham', ticker: 'aedngn', monierateMarket: 'parallel', cbnOfficial: true },
  { code: 'CNY', name: 'Chinese Yuan Renminbi', ticker: 'cnyngn', monierateMarket: 'parallel', cbnOfficial: true },
  { code: 'ZAR', name: 'South African Rand', ticker: 'zarngn', monierateMarket: 'parallel', cbnOfficial: true },

  // The CFA francs. CBN publishes one unified official series; Monierate carries
  // XOF and XAF as separate live pairs, so parallel is split and official is shared.
  {
    code: 'XOF',
    name: 'West African CFA Franc',
    ticker: 'xofngn',
    monierateMarket: 'parallel',
    cbnOfficial: true,
    note:
      'CBN publishes a single unified "CFA" official series covering both XOF and XAF; ' +
      'the two are pegged at parity to EUR and trade 1:1, so that official rate is ' +
      'reported for both. The parallel rates are genuinely distinct — Monierate ' +
      'quotes xofngn and xafngn as separate pairs.',
  },
  {
    code: 'XAF',
    name: 'Central African CFA Franc',
    ticker: 'xafngn',
    monierateMarket: 'parallel',
    cbnOfficial: true,
    officialFrom: 'XOF',
    note:
      'Official rate is CBN\'s unified "CFA" series, shared with XOF. The parallel ' +
      'rate is quoted independently for xafngn.',
  },

  // Official only — CBN publishes these; Monierate has no genuine street quotes.
  // CHF/JPY/DKK have live tickers but every quote is a reference feed; SAR has no
  // pair at all. Free to carry: they arrive in the same CBN payload, no extra call.
  { code: 'CHF', name: 'Swiss Franc', ticker: null, monierateMarket: null, cbnOfficial: true },
  { code: 'JPY', name: 'Japanese Yen', ticker: null, monierateMarket: null, cbnOfficial: true },
  { code: 'DKK', name: 'Danish Krone', ticker: null, monierateMarket: null, cbnOfficial: true },
  { code: 'SAR', name: 'Saudi Riyal', ticker: null, monierateMarket: null, cbnOfficial: true },
] as const

export const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code)

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]))

export function getCurrency(code: string): CurrencyDef | undefined {
  return BY_CODE.get(code.toUpperCase())
}

/** A currency known to have a Monierate ticker. */
export type MonierateCurrency = CurrencyDef & { ticker: string }

/** Currencies with a Monierate ticker — the set the 15-minute sync fans out over. */
export const MONIERATE_CURRENCIES: readonly MonierateCurrency[] = CURRENCIES.filter(
  (c): c is MonierateCurrency => c.ticker !== null,
)

/**
 * Currencies CBN publishes an official rate for under their own label. Excludes
 * XAF, which borrows XOF's unified CFA series rather than having a label of its own.
 */
export const CBN_CURRENCIES: readonly CurrencyDef[] = CURRENCIES.filter(
  (c) => c.cbnOfficial && c.officialFrom === undefined,
)

/**
 * CBN's own currency labels are dirty — the raw feed carries trailing tabs,
 * double spaces, and two spellings of the same currency ("DANISH KRONA" and
 * "DANISH KRONER", "POUND STERLING" and "POUNDS STERLING"). Labels are
 * whitespace-normalised and uppercased before lookup.
 */
export const CBN_LABEL_TO_CODE: Readonly<Record<string, string>> = {
  'US DOLLAR': 'USD',
  EURO: 'EUR',
  'POUNDS STERLING': 'GBP',
  'POUND STERLING': 'GBP',
  'YUAN/RENMINBI': 'CNY',
  'SOUTH AFRICAN RAND': 'ZAR',
  'UAE DIRHAM': 'AED',
  CFA: 'XOF',
  'SWISS FRANC': 'CHF',
  YEN: 'JPY',
  'JAPANESE YEN': 'JPY',
  'DANISH KRONA': 'DKK',
  'DANISH KRONER': 'DKK',
  RIYAL: 'SAR',
}

/**
 * Labels we recognise and deliberately drop. Keeping them distinct from
 * "unmapped" is the point: anything outside both sets is a CBN rename or a new
 * currency, and gets logged loudly instead of silently vanishing.
 *
 * SDR and WAUA are accounting units, not tradeable currencies. NAIRA (8 rows)
 * and POESO (3 rows) are upstream data-entry errors.
 */
export const CBN_IGNORED_LABELS: ReadonlySet<string> = new Set([
  'SDR',
  'WAUA',
  'NAIRA',
  'POESO',
])

export function normaliseCbnLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase()
}

/**
 * Resolve a raw CBN label to an ISO code.
 * `'ignored'` = known and intentionally skipped. `'unmapped'` = needs attention.
 */
export function resolveCbnLabel(
  raw: string,
): { kind: 'mapped'; code: string } | { kind: 'ignored' } | { kind: 'unmapped'; label: string } {
  const label = normaliseCbnLabel(raw)
  const code = CBN_LABEL_TO_CODE[label]
  if (code) return { kind: 'mapped', code }
  if (CBN_IGNORED_LABELS.has(label)) return { kind: 'ignored' }
  return { kind: 'unmapped', label }
}
