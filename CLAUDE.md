# nairarate.dev — Build Spec
> x402-gated Nigerian FX Intelligence API  
> Hand this to your coding agent as the source of truth. Read **Context** first.

---

## Context: what this is and why

**The product.** `nairarate.dev` is a pay-per-call HTTP API that returns Nigerian exchange rate intelligence across three markets simultaneously: the CBN official rate, the parallel (black) market rate, and the USDT street price. Callers pay per request via the x402 protocol in USDC on Base — no API key, no account, no subscription. One curl command, one payment, one structured JSON response.

**Why it exists.** No global FX API publishes Nigerian parallel market rates or USDT/NGN street prices. Global free APIs (Frankfurter, ExchangeRate-API) only carry official mid-market rates and don't include NGN parallel market data at all. The spread between the CBN official rate, the parallel market rate, and the USDT street price is the single most important signal for anyone transacting in or around Nigeria — and it's available nowhere as a structured, per-call API. This is the gap.

**Who pays for it.** AI agents doing Nigerian market intelligence, risk modeling for NGN-exposed transactions, remittance routing, crypto arbitrage detection, African fintech research. Any agent in the x402 ecosystem that needs Nigerian FX data pays per call rather than managing a subscription.

**The broader roadmap.** This is Layer 1 of a 3-layer African financial data API:
- Layer 1 (this build): Nigerian FX rates — parallel market + official + stablecoin
- Layer 2: CBN policy and regulatory feed — MPC decisions, circulars, FX interventions
- Layer 3: Open Banking market intelligence — anonymized aggregate transaction data via CBN Open Banking Registry

**Data sources confirmed:**
- **Monierate PAYG** (`api.monierate.com`) — parallel market rates + USDT/NGN across 40+ providers. $0.01/call. All v1 currencies confirmed supported: USD, EUR, GBP, USDT, AED, CNY, CAD, ZAR, XOF, XAF.
- **CBN page scrape** (`cbn.gov.ng/rates/ExchRateByCurrency.html`) — official NFEM rate. Free. Updates once per business day.

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Cloudflare Workers | Edge-distributed, sub-10ms, zero infra |
| Framework | Hono | Lightweight, first-class Workers support |
| Language | TypeScript | Consistent with x402 ecosystem tooling |
| Hot cache | Cloudflare KV | Latest rates served from KV — no upstream call on request path |
| Historical store | Cloudflare D1 (SQLite) | Rate snapshots for trend computation and `/history` endpoint |
| Scheduler | Cloudflare Cron Triggers | No external cron service needed |
| Payment middleware | x402 Cloudflare/Hono middleware | Coinbase reference implementation |
| Deployment | Wrangler CLI | Single command deploy |
| Domain | nairarate.dev (Cloudflare Registrar) | DNS + Workers routing in same place |

---

## Repository layout

```
nairarate/
  wrangler.toml              # Workers config — cron triggers, KV + D1 bindings
  .env.example               # MONIERATE_API_KEY, X402_WALLET_ADDRESS — never commit real keys
  src/
    index.ts                 # Hono app entry point — route definitions + x402 middleware
    routes/
      rates.ts               # GET /v1/rates — main endpoint
      history.ts             # GET /v1/rates/history — historical snapshots
      health.ts              # GET /health — no payment required
    collectors/
      monierate.ts           # Monierate API client — fetches parallel + USDT rates
      cbn.ts                 # CBN page scraper — fetches official NFEM rate
    jobs/
      sync-monierate.ts      # Cron: every 15 min — fetch + store Monierate data
      sync-cbn.ts            # Cron: daily 8am Lagos — fetch + store CBN data
    cache/
      kv.ts                  # KV read/write helpers — latest rate store
      d1.ts                  # D1 read/write helpers — historical snapshots
    compute/
      spreads.ts             # Computes spread fields from raw rate data
      trend.ts               # Computes 7-day trend direction from D1 history
      confidence.ts          # Computes confidence score based on data freshness
    types/
      rates.ts               # TypeScript types — RateSnapshot, ApiResponse, etc.
  schema.sql                 # D1 schema — rate_snapshots table
  README.md                  # Curl examples, endpoint docs, pricing
```

---

## D1 schema

```sql
-- schema.sql
CREATE TABLE IF NOT EXISTS rate_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,        -- 'monierate' | 'cbn'
  currency    TEXT NOT NULL,        -- 'USD' | 'EUR' | 'USDT' etc.
  market      TEXT NOT NULL,        -- 'official' | 'parallel' | 'crypto_street'
  buy         REAL,                 -- buy rate in NGN
  sell        REAL,                 -- sell rate in NGN
  mid         REAL,                 -- mid rate (for official/reference rates)
  provider_count INTEGER,           -- how many Monierate providers quoted this
  fetched_at  INTEGER NOT NULL,     -- unix timestamp
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_snapshots_currency_market
  ON rate_snapshots(currency, market, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_fetched_at
  ON rate_snapshots(fetched_at DESC);
```

---

## Cron jobs

### Job 1 — Monierate sync (every 15 minutes)

```
[triggers]
crons = ["*/15 * * * *"]
```

Logic:
1. Call `GET https://api.monierate.com/core/rates/latest.json?base=NGN` with `api_key` header.
2. Extract rates for: USD, EUR, GBP, USDT, AED, CNY, CAD, ZAR, XOF, XAF.
3. For each currency, write a `rate_snapshots` row with `source='monierate'`, `market='parallel'` (or `'crypto_street'` for USDT).
4. Write the full normalized payload to KV under key `latest:monierate` with no TTL (cron keeps it fresh).
5. On failure: log error, do NOT overwrite KV (stale data is better than empty data). Set a `last_monierate_error` KV key with timestamp for confidence scoring.

### Job 2 — CBN scrape (daily, 7:00 UTC = 8:00 Lagos)

```
crons = ["0 7 * * 1-5"]   # weekdays only — CBN doesn't publish on weekends
```

Logic:
1. Fetch `https://www.cbn.gov.ng/rates/ExchRateByCurrency.html`.
2. Parse the HTML table — extract NFEM rate for USD, EUR, GBP (CBN only publishes major pairs officially).
3. Write `rate_snapshots` rows with `source='cbn'`, `market='official'`.
4. Write to KV under key `latest:cbn`.
5. On failure: log, preserve last successful KV value, set `last_cbn_error` KV key.

**CBN scrape implementation note:** The CBN page is plain HTML (no JS rendering required). The rate table has a consistent structure — use a regex or simple HTML parser targeting the table rows. Do not use a headless browser. If the page structure changes, the confidence scorer will detect staleness automatically.

---

## API endpoints

### `GET /health`
No payment. Returns source freshness status. Used by monitoring and by callers to check before paying.

```json
{
  "status": "ok",
  "sources": {
    "monierate": {
      "last_success": "2026-07-28T10:15:00Z",
      "age_minutes": 3,
      "healthy": true
    },
    "cbn": {
      "last_success": "2026-07-28T07:00:00Z",
      "age_minutes": 195,
      "healthy": true
    }
  }
}
```

---

### `GET /v1/rates` — **x402 gated, $0.002 per call**

Returns the full rate payload for all v1 currencies across all markets.

**Query parameters:**
- `currencies` (optional) — comma-separated filter, e.g. `?currencies=USD,USDT,AED`. Default: all.
- `markets` (optional) — `official|parallel|crypto_street|all`. Default: `all`.

**Response:**

```json
{
  "timestamp": "2026-07-28T10:18:00Z",
  "base": "NGN",
  "data_age": {
    "parallel_minutes": 3,
    "official_minutes": 195
  },
  "confidence": "high",
  "rates": {
    "USD": {
      "official": {
        "mid": 1373.5,
        "source": "CBN NFEM",
        "updated_at": "2026-07-28T07:00:00Z"
      },
      "parallel": {
        "buy": 1390.0,
        "sell": 1405.0,
        "mid": 1397.5,
        "provider_count": 12,
        "source": "Monierate (40+ providers)",
        "updated_at": "2026-07-28T10:15:00Z"
      }
    },
    "USDT": {
      "crypto_street": {
        "buy": 1388.0,
        "sell": 1392.0,
        "mid": 1390.0,
        "provider_count": 8,
        "source": "Monierate (crypto providers)",
        "updated_at": "2026-07-28T10:15:00Z"
      }
    },
    "EUR": { "...": "same shape as USD" },
    "GBP": { "...": "same shape" },
    "AED": { "...": "parallel only — no CBN official for AED" },
    "CNY": { "...": "parallel only" },
    "CAD": { "...": "parallel only" },
    "ZAR": { "...": "parallel only" },
    "XOF": { "...": "parallel only" },
    "XAF": { "...": "parallel only" }
  },
  "spreads": {
    "USD": {
      "parallel_vs_official_pct": 1.75,
      "usdt_vs_official_pct": 1.20,
      "usdt_vs_parallel_pct": -0.54
    }
  },
  "trend_7d": {
    "USD_parallel_direction": "stable",
    "USD_official_direction": "appreciating",
    "USD_spread_direction": "compressing"
  }
}
```

**Confidence scoring logic** (in `src/compute/confidence.ts`):

| Condition | Confidence |
|-----------|-----------|
| Monierate data < 20 min old AND CBN data from today | `"high"` |
| Monierate data 20–60 min old OR CBN data from yesterday (weekend) | `"medium"` |
| Monierate data > 60 min old OR last fetch errored | `"low"` |
| Monierate unreachable for > 2 hours | `"degraded"` — still return last known data |

Always return data even at `"degraded"` — stale rates are more useful than an error for an agent mid-task.

---

### `GET /v1/rates/history` — **x402 gated, $0.005 per call**

Returns rate snapshots for the last N days for a specific currency and market.

**Query parameters:**
- `currency` (required) — e.g. `USD`
- `market` (required) — `official|parallel|crypto_street`
- `days` (optional) — 1–30, default 7

**Response:**

```json
{
  "currency": "USD",
  "market": "parallel",
  "days": 7,
  "snapshots": [
    {
      "date": "2026-07-28",
      "buy": 1390.0,
      "sell": 1405.0,
      "mid": 1397.5
    }
  ],
  "trend": {
    "direction": "stable",
    "change_pct_7d": -0.2,
    "high": 1415.0,
    "low": 1388.0
  }
}
```

---

## x402 middleware integration

The x402 payment middleware wraps all gated routes. Install the Coinbase reference package:

```bash
npm install x402-hono
```

Wire it in `src/index.ts`:

```typescript
import { Hono } from 'hono'
import { paymentMiddleware } from 'x402-hono'

const app = new Hono()

// Free routes first
app.get('/health', healthHandler)

// x402-gated routes
app.use('/v1/*', paymentMiddleware({
  facilitatorUrl: 'https://x402.org/facilitator',
  routes: {
    'GET /v1/rates': {
      price: '$0.002',
      network: 'base',
      description: 'Nigerian FX rates — all markets, all currencies',
    },
    'GET /v1/rates/history': {
      price: '$0.005',
      network: 'base',
      description: 'Historical Nigerian FX rate snapshots',
    },
  },
}))

app.get('/v1/rates', ratesHandler)
app.get('/v1/rates/history', historyHandler)

export default app
```

**Important:** The `GET /v1/rates` handler must read from KV only — never call Monierate or CBN on the request path. The cron jobs keep KV fresh. This ensures payment and response complete in <100ms regardless of upstream latency.

---

## KV key structure

```
latest:monierate          # Full Monierate normalized payload, JSON string
latest:cbn                # CBN official rates payload, JSON string
meta:last_monierate_ok    # ISO timestamp of last successful Monierate fetch
meta:last_cbn_ok          # ISO timestamp of last successful CBN fetch
meta:last_monierate_error # ISO timestamp + error message of last failure
meta:last_cbn_error       # ISO timestamp + error message of last failure
```

---

## Spread computation (`src/compute/spreads.ts`)

Computed on every `/v1/rates` request from the KV-cached data. Not stored.

```typescript
function computeSpread(official: number, parallel: number): number {
  return parseFloat(((parallel - official) / official * 100).toFixed(2))
}
```

Spreads are only computed where both markets have data for the same currency. USD, EUR, GBP get full three-way spreads (official + parallel + USDT). Other currencies get parallel-only (no CBN official counterpart).

---

## Trend computation (`src/compute/trend.ts`)

Computed from D1 on the `/v1/rates/history` endpoint and on the `trend_7d` field in `/v1/rates`. D1 query:

```sql
SELECT date(fetched_at, 'unixepoch') as date,
       AVG(mid) as mid,
       AVG(buy) as buy,
       AVG(sell) as sell
FROM rate_snapshots
WHERE currency = ? AND market = ?
  AND fetched_at >= unixepoch('now', '-7 days')
GROUP BY date(fetched_at, 'unixepoch')
ORDER BY date ASC
```

Direction logic:
- Compare 7-day-ago mid to today's mid.
- `> +0.5%` → `"depreciating"` (NGN weakening)
- `< -0.5%` → `"appreciating"` (NGN strengthening)
- Within ±0.5% → `"stable"`

---

## `wrangler.toml`

```toml
name = "nairarate"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "RATES_KV"
id = "YOUR_KV_NAMESPACE_ID"

[[d1_databases]]
binding = "RATES_DB"
database_name = "nairarate"
database_id = "YOUR_D1_DB_ID"

[triggers]
crons = ["*/15 * * * *", "0 7 * * 1-5"]

[vars]
ENVIRONMENT = "production"
```

Secrets (set via `wrangler secret put`):
- `MONIERATE_API_KEY` — Monierate API key. Local value lives in `.dev.vars` (gitignored); never inline it here.
- `X402_WALLET_ADDRESS` — your USDC wallet on Base that receives payments

---

## README curl example (what goes on the landing page)

```bash
# No API key needed — just pay per call via x402

# Check if sources are fresh (free)
curl https://nairarate.dev/health

# Get all NGN rates (costs $0.002 in USDC on Base)
curl https://nairarate.dev/v1/rates \
  -H "X-PAYMENT: <x402-payment-token>"

# Filter to USD and USDT only
curl "https://nairarate.dev/v1/rates?currencies=USD,USDT"

# Get 7-day USD parallel market history (costs $0.005)
curl "https://nairarate.dev/v1/rates/history?currency=USD&market=parallel&days=7" \
  -H "X-PAYMENT: <x402-payment-token>"
```

---

## Order of work

1. **Scaffold** — `wrangler init`, install Hono, create KV namespace and D1 database, run `schema.sql`, set secrets.
2. **Collectors** — build `monierate.ts` and `cbn.ts` clients. Test both with real API calls. Verify all 10 currencies return data from Monierate.
3. **Cron jobs** — wire up both sync jobs. Run manually with `wrangler dev` + trigger via HTTP. Confirm data lands in D1 and KV.
4. **`/health` endpoint** — implement first, no payment required. Confirm it reads from KV meta keys correctly.
5. **`/v1/rates` endpoint** — read from KV, compute spreads and trends, return response. Test the full payload shape.
6. **x402 middleware** — wrap `/v1/*` routes. Test payment flow end-to-end against Base Sepolia testnet first.
7. **`/v1/rates/history` endpoint** — D1 query, trend computation, response.
8. **Confidence scorer** — wire staleness detection to `confidence` field.
9. **Deploy** — `wrangler deploy`. Point `nairarate.dev` DNS to Workers.
10. **README + landing page** — curl examples, pricing, what you get. Register on x402 directories (awesome-x402 list).

Stop after step 9 and verify the full payment flow works on mainnet with a real $0.002 call before listing anywhere.

---

## Explicit non-goals for v1

- No authentication layer beyond x402 payment
- No rate limiting beyond what x402 enforces
- No webhook/push notifications
- No GraphQL, no WebSocket
- No frontend dashboard
- No USDC/NGN (Monierate doesn't carry it — add in v2 if demand warrants)
- No historical data before build date (D1 starts accumulating from deploy day)