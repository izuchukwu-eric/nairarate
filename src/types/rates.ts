export type Market = 'official' | 'parallel' | 'crypto_street'

export type Confidence = 'high' | 'medium' | 'low' | 'degraded'

export type TrendDirection = 'appreciating' | 'depreciating' | 'stable'

export type SpreadDirection = 'compressing' | 'widening' | 'stable'

export type SourceName = 'monierate' | 'cbn'

export interface Env {
  RATES_KV: KVNamespace
  RATES_DB: D1Database
  ENVIRONMENT: string
  /** 'base' | 'base-sepolia'. Defaults to base-sepolia when unset or unrecognised. */
  X402_NETWORK?: string
  /** Secrets — absent until `wrangler secret put`. */
  MONIERATE_API_KEY?: string
  /** USDC-on-Base address that receives payments. Payment gating is off without it. */
  X402_WALLET_ADDRESS?: string
}

// ---------------------------------------------------------------------------
// Collector output
// ---------------------------------------------------------------------------

/** One currency's rate for one market, as produced by a collector. */
export interface RateObservation {
  currency: string
  market: Market
  /** NGN received per unit of foreign currency — the low side. */
  bid: number | null
  /** NGN paid per unit of foreign currency — the high side. */
  ask: number | null
  mid: number | null
  /** Present on daily series (CBN, Monierate roll-ups). */
  rateDate?: string
  open?: number | null
  high?: number | null
  low?: number | null
  close?: number | null
  /** NFEM market depth. USD official only. */
  turnover?: number | null
  dealCount?: number | null
  providerCount?: number | null
}

/** Normalised CBN payload, written to KV as `latest:cbn`. */
export interface CbnPayload {
  /** Newest business date any currency reached, 'YYYY-MM-DD'. Individual
   * currencies carry their own `rateDate` — see CbnRate. */
  rateDate: string
  /** When we fetched it — unix seconds. */
  fetchedAt: number
  rates: Record<string, CbnRate>
  /** Labels present upstream that we could not map. Empty in the healthy case. */
  unmappedLabels: string[]
}

export interface CbnRate {
  /**
   * The business date this currency's rate is for. Per-currency, not per-payload:
   * CBN publishes partially, so AED can legitimately lag USD by a day.
   */
  rateDate: string
  bid: number | null
  ask: number | null
  mid: number
  /** NFEM depth — USD only. */
  high?: number | null
  low?: number | null
  close?: number | null
  turnover?: number | null
  dealCount?: number | null
}

/** Normalised Monierate payload, written to KV as `latest:monierate`. */
export interface MonieratePayload {
  fetchedAt: number
  rates: Record<string, MonierateRate>
  /** Tickers that failed this run. Drives per-currency staleness. */
  failedTickers: string[]
}

export interface MonierateRate {
  market: Extract<Market, 'parallel' | 'crypto_street'>
  bid: number | null
  ask: number | null
  mid: number | null
  providerCount: number
  /** Newest `last_updated` across contributing platforms — unix seconds. */
  updatedAt: number
  /** True when the value came from the latest.json fallback, not platforms.json. */
  fallback: boolean
}

// ---------------------------------------------------------------------------
// API response
// ---------------------------------------------------------------------------

export interface MarketQuote {
  /** NGN received per unit of foreign currency — the low side. */
  bid: number | null
  /** NGN paid per unit of foreign currency — the high side. */
  ask: number | null
  mid: number | null
  provider_count?: number
  source: string
  updated_at: string
}

export interface OfficialQuote extends MarketQuote {
  high?: number | null
  low?: number | null
  close?: number | null
  turnover?: number | null
  deal_count?: number | null
}

export interface CurrencyRates {
  official: OfficialQuote | null
  parallel: MarketQuote | null
  crypto_street: MarketQuote | null
  note?: string
}

export interface Spreads {
  parallel_vs_official_pct: number | null
  usdt_vs_official_pct: number | null
  usdt_vs_parallel_pct: number | null
  usdc_vs_official_pct: number | null
  usdc_vs_parallel_pct: number | null
}

export interface TrendBlock {
  parallel_direction: TrendDirection | null
  official_direction: TrendDirection | null
  spread_direction: SpreadDirection | null
}

export interface RatesResponse {
  timestamp: string
  base: 'NGN'
  data_age: {
    parallel_minutes: number | null
    official_minutes: number | null
  }
  confidence: Confidence
  /** Populated when confidence is degraded or a source is missing entirely. */
  warnings?: string[]
  rates: Record<string, CurrencyRates>
  spreads: Record<string, Spreads>
  trend_7d: Record<string, TrendBlock>
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  sources: Record<
    SourceName,
    {
      last_success: string | null
      age_minutes: number | null
      healthy: boolean
      last_error: string | null
    }
  >
}

export interface HistorySnapshot {
  date: string
  bid: number | null
  ask: number | null
  mid: number | null
}

export interface HistoryResponse {
  currency: string
  market: Market
  days: number
  snapshots: HistorySnapshot[]
  trend: {
    direction: TrendDirection | null
    change_pct: number | null
    high: number | null
    low: number | null
  }
  note?: string
}
