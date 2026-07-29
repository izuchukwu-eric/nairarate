# nairarate.dev

**Nigerian FX intelligence across three markets in one call** — the CBN official rate, the parallel ("black market") rate, and USDT/USDC street prices, plus the spreads between them, 7-day trends and a freshness-based confidence score.

Paid per call in USDC on Base via [x402](https://x402.org). No API key, no account, no subscription.

```bash
# Source freshness — free, no wallet needed
curl https://nairarate.dev/health

# All markets, all currencies — $0.03 via x402
curl https://nairarate.dev/v1/rates
```

## Why this exists

No global FX API publishes Nigeria's parallel market rate or the USDT/NGN street price. Frankfurter, ExchangeRate-API and the rest carry the official mid only. But the spread between the official rate, the street rate and the stablecoin rate is the signal that actually matters for anything priced in or around naira — remittance routing, NGN-exposed risk, arbitrage detection, African fintech research — and it isn't otherwise available as a structured, per-call API.

That gap is the product.

## Endpoints

| | | |
|---|---|---|
| `GET /health` | **free** | Per-source freshness. Check before paying. |
| `GET /v1/rates` | **$0.03** | All markets and currencies, with spreads and 7-day trends. |
| `GET /v1/rates/history` | **$0.05** | Daily series for one currency and market, with trend, high and low. |
| `GET /.well-known/x402` | free | Machine-readable service manifest. |
| `GET /llms.txt` | free | Plain-text description for agents. |
| `GET /methodology` | free | How the rates are derived and screened. |
| `GET /openapi.json` | free | OpenAPI 3.1 spec. |

Everything an agent needs to decide whether to pay is free. Paid routes return `402` with requirements in the `PAYMENT-REQUIRED` header; an x402-capable client handles that automatically.

### `GET /v1/rates`

`?currencies=USD,USDT` to filter (default: all) · `?markets=official|parallel|crypto_street|all`

```jsonc
{
  "timestamp": "2026-07-29T02:45:00.000Z",
  "base": "NGN",
  "data_age": { "parallel_minutes": 3, "official_minutes": 195 },
  "confidence": "high",
  "rates": {
    "USD": {
      "official":      { "bid": 1364.53, "ask": 1365.53, "mid": 1365.53,
                         "source": "CBN NFEM", "updated_at": "2026-07-28T00:00:00Z",
                         "high": 1368, "low": 1363, "turnover": 239274144.83 },
      "parallel":      { "bid": 1383.48, "ask": 1402.91, "mid": 1393.19,
                         "provider_count": 43, "source": "Monierate (43 providers, median)" },
      "crypto_street": null
    }
  },
  "spreads": { "USD": { "parallel_vs_official_pct": 2.03, "usdc_vs_parallel_pct": 0.22 } },
  "trend_7d": { "USD": { "official_direction": "appreciating", "spread_direction": "compressing" } }
}
```
*Illustrative values — rates move daily.*

### `GET /v1/rates/history`

`?currency=USD` **(required)** · `?market=official|parallel|crypto_street` **(required)** · `?days=1..30` (default 7)

Official series reach back to **2001-12-10**. Parallel and street series accumulate from this deployment's first daily roll-up, so they are shallower.

## Coverage is asymmetric — and reported honestly

| | official (CBN) | parallel | crypto street |
|---|---|---|---|
| USD, EUR, GBP | ✅ | ✅ | — |
| CAD | — | ✅ | — |
| USDT, USDC | — | — | ✅ |
| AED, CNY, ZAR, XOF, XAF | ✅ | ✅ *(thin)* | — |
| CHF, JPY, DKK, SAR | ✅ | — | — |

A market a currency has no source for comes back as `null`, never a fabricated number, and its spread is `null` too. Asking `/v1/rates/history` for a combination that doesn't exist returns `400` **with an explanation** rather than an empty array you paid for.

`provider_count` is the number of independent street quotes behind a parallel rate — 43 for USD, as low as 1 for thinly quoted currencies. Check it before relying on a rate.

`confidence` is `high | medium | low | degraded`, from source freshness. **Data is always returned, even at `degraded`** — a stale rate is more useful to an agent mid-task than an error — and `warnings` explains any downgrade.

## Conventions

- **Base is NGN.** Every rate is naira per unit of the quoted currency.
- **`bid`** — NGN received per unit of foreign currency (the low side).
- **`ask`** — NGN paid per unit of foreign currency (the high side). `bid <= ask` always.

The two upstreams disagree on direction — CBN's `buyingrate` is the low side while the parallel source's `buy` is the high side — so both are normalised to `bid`/`ask` on ingest. Storing either upstream's own field names would give one field two opposite meanings.

## Methodology

Raw provider lists cannot simply be averaged. Unscreened, USD returns a mid of **1181** against a true **~1392**. Four things are excluded, and [`/methodology`](https://nairarate.dev/methodology) says so publicly:

1. A quote of `0` means "no quote on that side", not a rate of zero — remittance corridors publish only a send rate (19 of 65 USD providers).
2. The central bank quotes inside the provider list; including it drags the parallel rate toward the official one and understates the spread.
3. Reference and institutional feeds aren't street rates.
4. Outright bad data — one feed quoted GBP at 130 against a ~1850 market.

Survivors are aggregated by **median**, not mean. Cross-checked against an independently computed composite: **0.4% variance**, different methodologies, same market. See [METHODOLOGY.md](METHODOLOGY.md).

Official history is screened too — CBN's own published series contains genuine data-entry errors (a Danish krone printed at 198,024 against a ~200 baseline), and two-sided bands are reconciled against the mid.

## Architecture

Cloudflare Workers + Hono, KV for the hot path, D1 for history.

```
cron */15 * * * *  →  Monierate collector  →  screen → median → KV + D1
cron 0 7 * * 1-5   →  CBN collector        →  KV + D1, roll-up, prune
                      ↓ both rebuild the served payload
GET /v1/rates      →  one KV read. No D1, no upstream call, no surprises.
```

Spreads, trends and confidence are precomputed by the cron, so a paid request can't be made slow by an upstream being slow, or fail because one is down. If the KV payload is missing, official rates fall back to D1 rather than serving `null`.

Neither collector's failure clears cached data: a failed sync leaves the previous payload in place and annotates it.

## Local development

```bash
npm install
cp .env.example .dev.vars        # add MONIERATE_API_KEY
npx wrangler kv namespace create RATES_KV
npx wrangler d1 create nairarate # paste both IDs into wrangler.toml
npm run db:init:local

npm run backfill:cbn             # generate ~51k official rows (free, no key)
npm run backfill:cbn:apply:local

npm run dev
```

Verification scripts, both of which hit live upstreams:

```bash
npm run probe:cbn                # 27 assertions on the CBN collector
npm run probe:monierate          # ticker coverage + screening, 0 billable calls
```

`.dev.vars` overrides `X402_NETWORK` to `base-sepolia` so local development never touches mainnet.

See [DEPLOY.md](DEPLOY.md) for the deployment checklist and [DISTRIBUTION.md](DISTRIBUTION.md) for discovery and listing.

## Cost notes

The parallel-market source is billed per call in NGN, so **upstream cost floats with the currency being reported on**. Steady-state collection uses only the non-billable endpoint, so the running cost is effectively zero; a billable fallback exists for genuine outages and is capped at 2 calls per sync run, with a wallet-balance floor that disables it rather than draining the balance and 402-ing every later sync.

## Roadmap

Layer 1 of a three-layer African financial data API:

- **Layer 1** *(this)* — Nigerian FX: parallel + official + stablecoin
- **Layer 2** — CBN policy and regulatory feed: MPC decisions, circulars, FX interventions
- **Layer 3** — Open Banking market intelligence via the CBN Open Banking Registry
