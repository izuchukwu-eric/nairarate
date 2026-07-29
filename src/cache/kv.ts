import type { CbnPayload, Env, MonieratePayload, RatesResponse, SourceName } from '../types/rates'

/**
 * KV is the request path. `/v1/rates` reads exactly one key — `latest:rates`,
 * the fully assembled response written by the cron with spreads, trends and
 * confidence already computed. The per-source payloads and meta keys exist for
 * the cron to rebuild from and for /health to report on.
 */
export const KV_KEYS = {
  /** Precomputed /v1/rates response body. */
  rates: 'latest:rates',
  monierate: 'latest:monierate',
  cbn: 'latest:cbn',
  lastOk: (source: SourceName) => `meta:last_${source}_ok` as const,
  lastError: (source: SourceName) => `meta:last_${source}_error` as const,
  /** Last known Monierate prepaid wallet balance, in NGN. */
  walletNgn: 'meta:monierate_wallet_ngn',
} as const

export interface SourceError {
  at: string
  message: string
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, 'json')
  } catch (err: unknown) {
    // A malformed value must not take down the request path.
    console.error(`kv: failed to read ${key}`, err)
    return null
  }
}

async function writeJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  // No TTL anywhere: the crons keep these fresh, and an expired key would turn
  // stale-but-useful data into no data at all.
  await kv.put(key, JSON.stringify(value))
}

export function getCachedRates(env: Env): Promise<RatesResponse | null> {
  return readJson<RatesResponse>(env.RATES_KV, KV_KEYS.rates)
}

export function putCachedRates(env: Env, payload: RatesResponse): Promise<void> {
  return writeJson(env.RATES_KV, KV_KEYS.rates, payload)
}

export function getCbnPayload(env: Env): Promise<CbnPayload | null> {
  return readJson<CbnPayload>(env.RATES_KV, KV_KEYS.cbn)
}

export function putCbnPayload(env: Env, payload: CbnPayload): Promise<void> {
  return writeJson(env.RATES_KV, KV_KEYS.cbn, payload)
}

export function getMonieratePayload(env: Env): Promise<MonieratePayload | null> {
  return readJson<MonieratePayload>(env.RATES_KV, KV_KEYS.monierate)
}

export function putMonieratePayload(env: Env, payload: MonieratePayload): Promise<void> {
  return writeJson(env.RATES_KV, KV_KEYS.monierate, payload)
}

/** Record a successful fetch. Clears the paired error key so it cannot go stale. */
export async function markSourceOk(env: Env, source: SourceName, at: Date): Promise<void> {
  await Promise.all([
    env.RATES_KV.put(KV_KEYS.lastOk(source), at.toISOString()),
    env.RATES_KV.delete(KV_KEYS.lastError(source)),
  ])
}

/**
 * Record a failure without touching `latest:*`. Stale data beats empty data, so
 * a failed sync leaves the previous payload in place and only annotates it.
 */
export async function markSourceError(
  env: Env,
  source: SourceName,
  err: unknown,
  at: Date,
): Promise<void> {
  const payload: SourceError = {
    at: at.toISOString(),
    message: err instanceof Error ? err.message : String(err),
  }
  await writeJson(env.RATES_KV, KV_KEYS.lastError(source), payload)
}

/**
 * Read the last known Monierate wallet balance in NGN.
 *
 * Monierate exposes no balance endpoint — /account, /usage, /wallet, /billing and
 * /me all 404 — so the figure is captured from `_meta.billing.wallet_balance_after`
 * on billable responses and persisted here. Because billable fallbacks are the
 * only thing this service spends on, the stored value is exact as of the last
 * spend. It can drift high if the wallet is spent elsewhere (the dashboard, the
 * Monierate backfill script), so it is treated as an upper bound.
 *
 * Null means we have never made a billable call and genuinely do not know.
 */
export async function getWalletBalanceNgn(env: Env): Promise<number | null> {
  const raw = await env.RATES_KV.get(KV_KEYS.walletNgn)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export async function putWalletBalanceNgn(env: Env, balanceNgn: number): Promise<void> {
  await env.RATES_KV.put(KV_KEYS.walletNgn, String(balanceNgn))
}

export async function getSourceStatus(
  env: Env,
  source: SourceName,
): Promise<{ lastOk: string | null; lastError: SourceError | null }> {
  const [lastOk, lastError] = await Promise.all([
    env.RATES_KV.get(KV_KEYS.lastOk(source)),
    readJson<SourceError>(env.RATES_KV, KV_KEYS.lastError(source)),
  ])
  return { lastOk, lastError }
}
