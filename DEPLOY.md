# Deploy checklist

Run in order. Every step has a verification — do not proceed past a failed check.

---

## 0. Blocker to resolve first

**On deploy day, `/v1/rates` will return `official: null` for all 15 currencies.**

Verified locally: `rebuild-payload.ts` reads official rates from the KV key
`latest:cbn`, which is only written by the CBN cron — and that cron runs
**weekdays at 07:00 UTC only**. The 51,028 backfilled official rows live in D1,
which the request path deliberately never touches.

So between deploying and the next weekday 07:00 UTC, the product serves
parallel rates with `confidence: medium` and every `parallel_vs_official_pct`
null — the headline number gone. Deploy on a Friday evening and that is ~60 hours.

Pick one before deploying:

| Option | Effort | Result |
|---|---|---|
| **A. D1 fallback in `rebuild-payload`** (recommended) | ~15 lines | Reads latest official rows from D1 when `latest:cbn` is absent. Removes the gap entirely and makes the service resilient to KV loss. |
| B. Time the deploy | none | Deploy Mon–Fri before 07:00 UTC, wait for the cron, verify, then announce. |
| C. Temporary extra cron | 1 line + redeploy | Add `"5 * * * *"` for the first day, then remove. |

Say which and it goes in before step 1.

---

## 1. Rotate the Monierate key

It was pasted into a chat transcript in plaintext.

```bash
# Generate a new key at https://account.monierate.com, then:
# update .dev.vars locally, and set the secret in step 4.
npm run probe:monierate          # must pass with the new key, 0 billable calls
```

**Verify:** probe reports 17/18 tickers live, `Billable calls this run: 0`.

---

## 2. Create KV and D1

```bash
npx wrangler kv namespace create RATES_KV
npx wrangler d1 create nairarate
```

Paste both returned IDs into `wrangler.toml`, replacing `YOUR_KV_NAMESPACE_ID`
and `YOUR_D1_DB_ID`.

**Verify:**

```bash
grep -E 'id = |database_id = ' wrangler.toml     # no YOUR_* placeholders remain
npx wrangler d1 list                             # nairarate present
```

---

## 3. Initialise the schema

```bash
npm run db:init                                  # remote
```

**Verify:**

```bash
npx wrangler d1 execute nairarate --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expect `rate_snapshots` and `rate_daily`.

---

## 4. Set secrets

```bash
npx wrangler secret put MONIERATE_API_KEY        # the rotated key from step 1
npx wrangler secret put X402_WALLET_ADDRESS      # USDC-on-Base receiving address
```

**Do NOT set `X402_NETWORK` as a secret.** I tested the collision: a secret
**silently overrides** the `[vars]` entry with no warning, and the binding then
displays as `"(hidden)"` in deploy output. `wrangler.toml` would still read
`base-sepolia` while the service ran on mainnet — the setting that decides
whether real money moves would be invisible in both the repo and the logs. Edit
`wrangler.toml` instead (step 8).

**Verify:**

```bash
npx wrangler secret list                         # exactly these two names
```

Double-check `X402_WALLET_ADDRESS` is an address **you control on Base** and can
receive USDC at. A typo here sends every payment somewhere unrecoverable — and
the middleware only validates the format, not the ownership.

---

## 5. Backfill official history

```bash
npm run backfill:cbn                             # regenerate; ~51k rows
npm run backfill:cbn:apply                       # apply to remote D1
```

**Verify:**

```bash
npx wrangler d1 execute nairarate --remote --command \
  "SELECT COUNT(*) rows, COUNT(DISTINCT currency) curr, MIN(rate_date) first,
          MAX(rate_date) last,
          SUM(CASE WHEN bid > ask THEN 1 ELSE 0 END) invalid
     FROM rate_daily;"
```

Expect ~51,000 rows, 11 currencies, first `2001-12-10`, **`invalid` = 0**.

Do **not** run `backfill:monierate` — deferred by decision, and it costs
~NGN 47,700.

---

## 6. Deploy to Sepolia first

`wrangler.toml` should still say `X402_NETWORK = "base-sepolia"`.

```bash
npm run typecheck                                # must be clean
npx wrangler deploy --dry-run                    # confirm bundle ~143 KiB gzip
npx wrangler deploy
```

---

## 7. Verify on Sepolia

Crons do not fire on deploy. The Monierate sync runs within 15 minutes; the CBN
sync waits for the next weekday 07:00 UTC (see step 0).

```bash
# Wait for the first Monierate cron, then:
curl -s https://<worker-subdomain>.workers.dev/health | jq
```

**Verify:** `sources.monierate.healthy: true`, `age_minutes` < 20.

```bash
curl -sD - -o /dev/null https://<worker-subdomain>.workers.dev/v1/rates \
  | grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d | jq '.accepts'
```

**Verify:** `network: "eip155:84532"`, `amount: "2000"`,
`asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"`, `payTo` = your address.

Then make a **real Sepolia payment** with an x402 client and confirm a 200 with
the rate payload. This is the last cheap chance to find a settlement problem.

**Verify:** 200, `confidence` present, `rates.USD.parallel.mid` populated.

---

## 8. Switch to mainnet

```bash
# Edit wrangler.toml:  X402_NETWORK = "base"
npx wrangler deploy
```

**Verify** the deploy output shows `env.X402_NETWORK ("base")` — visible, not
`(hidden)`. If it shows `(hidden)`, a secret is shadowing it; delete it with
`npx wrangler secret delete X402_NETWORK`.

---

## 9. Verify on production

```bash
curl -s https://nairarate.dev/health | jq
```

**Verify:** `status: "ok"`, both sources healthy.

```bash
curl -sD - -o /dev/null https://nairarate.dev/v1/rates \
  | grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d | jq '.accepts'
```

**Verify:** `network: "eip155:8453"`,
`asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` (mainnet USDC),
`payTo` = your address.

---

## 10. One real mainnet settlement

Pay **$0.002 of real USDC** on Base for one `/v1/rates` call with an x402 client.

**Verify all four:**

1. HTTP 200 with the full rate payload.
2. `X-PAYMENT-RESPONSE` header present with a settlement transaction hash.
3. That hash confirmed on Basescan, USDC arriving at `X402_WALLET_ADDRESS`.
4. **The USDC balance actually increased** — a confirmed transaction to the wrong
   address still confirms.

Then repeat once for `/v1/rates/history?currency=USD&market=official&days=7`
at $0.01, which exercises the `upto` path.

**Only after all of this is green does anything get submitted anywhere.**
See [DISTRIBUTION.md](DISTRIBUTION.md).

---

## 11. Post-launch watch

- **Monierate wallet.** NGN-denominated, so USD cost floats with the naira. The
  cron warns below NGN 500 and disables billable fallbacks. Steady state spends
  nothing; check the log warning weekly.
- **First CBN cron after launch.** Confirm `sync-cbn` logs 11 currencies and no
  unmapped labels. An unmapped label logs at `error` and means CBN renamed a
  currency.
- **First daily roll-up.** Confirm `rolled N daily row(s)`, after which
  `/history?market=parallel` starts returning data and `trend_7d` fills in over
  the following week.
