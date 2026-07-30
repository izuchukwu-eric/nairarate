# Launch

Numbers below were pulled **2026-07-30 01:38 UTC**. Rates move daily — **re-pull
immediately before posting** (`npm run launch:numbers`), or the post undermines its
own claim.

---

## The post

```
No FX API publishes Nigeria's parallel market rate. So I built one.

nairarate.dev returns all three NGN markets in one call — the CBN official
rate, the parallel ("black market") rate, and the USDT/USDC street price —
plus the spreads between them.

Right now: official ₦1,365.53, parallel ₦1,393.95, USDT ₦1,396.07.
A 2.08% spread that no mainstream FX API will show you.

$0.03 per call in USDC on Base via x402. No API key, no signup.

  curl https://nairarate.dev/v1/rates

Check the data is fresh before you pay anything — that part's free:

  curl https://nairarate.dev/health
```

**Why this shape.** The spread is the product, so it leads. The free `/health`
curl is the strongest line in it: a verifiable claim a reader can run in three
seconds with no wallet, no signup and no trust in me. Architecture is not
mentioned — nobody has ever paid for an API because it ran on Workers.

### Thread replies, in order of strength

**1 — the methodology.** The real moat, and the most credible thing to say:

```
The hard part isn't fetching the rate, it's knowing which quotes to throw away.

Aggregate the raw provider list naively and USD/NGN comes out at ₦1181
against a true ₦1392. The central bank quotes inside the parallel feed.
Remittance corridors report a missing side as zero. One feed had GBP at 130.

What gets excluded, and why: nairarate.dev/methodology
```

**2 — the history depth.** Advertises the $0.05 endpoint:

```
Also has history. Official NGN rates back to 2001-12-10 — 51,028 daily rows,
straight from the CBN's own feed.

Parallel and stablecoin history back to 2023-09-11.

  curl "https://nairarate.dev/v1/rates/history?currency=USD&market=parallel&days=365"
```

**3 — data quality, for the audience burned by bad FX data.** Only worth posting
if the thread has traction; it is the most niche and the most convincing:

```
Screening the history found real errors in the published sources.

A Danish krone printed at 198,024 against a ~200 baseline. 31 CBN rows where
the buying rate exceeds the selling rate. Three parallel rows on 2025-10-01
sitting 3.17x off their neighbours.

Largest *genuine* daily move in the whole set: 1.13x. So the threshold sits
at 2.5x — above the ~1.63x June 2023 float, well below the bad data.

All of it documented rather than quietly patched.
```

---

## What not to claim

- **Don't say "40+ providers"** without qualifying it. USD has 44 quoting; AED and
  CNY rest on **one**. `provider_count` is in every response for exactly this
  reason — say "up to 44, and the count is in the payload."
- **Don't imply every currency has every market.** Coverage is deliberately
  asymmetric: 3 have official+parallel, 2 are stablecoin-only, 4 are official-only.
- **Don't quote a spread without its timestamp.** They move daily.

---

## Live numbers, 2026-07-30 01:38 UTC

Confidence `high`, both sources healthy.

| | rate | |
|---|---|---|
| USD official | ₦1,365.53 | CBN NFEM, 2026-07-28 |
| USD parallel | ₦1,393.95 | 43 providers |
| USDT street | ₦1,396.07 | |
| USDC street | ₦1,398.35 | |

| spread | |
|---|---|
| parallel vs official | **+2.08%** |
| USDT vs official | +2.24% |

7-day USD trend: parallel `stable`, official `stable`, spread **`compressing`**.

`provider_count` moved 44 → 43 between two pulls twenty minutes apart. That is the
screening working, not instability — a changer dropped out or was rejected. Quote
whatever the number is at the moment you post.

All parallel-vs-official spreads: ZAR +5.50%, EUR +3.49%, GBP +3.33%, USD +2.08%,
XOF +1.72%, XAF +1.07%, CNY +0.45%, AED +0.25%.

---

## Proof it works, if anyone asks

Three real mainnet settlements, all verifiable:

| tx | endpoint | amount |
|---|---|---|
| [`0xea08c9a1…`](https://basescan.org/tx/0xea08c9a19990b1a073b1aa01368c7ed46dae53b897e9e0af536a3be361f01c40) | `/v1/rates` | $0.03 |
| [`0x914af781…`](https://basescan.org/tx/0x914af78152b7cd8f3ed8b91b1b44a8f507d013002205a8a2faec99b66882b661) | `/v1/rates/history` | $0.05 |
| `0xfc17622a…` | `/v1/rates` — **an unrelated wallet**, before any announcement | $0.03 |

That third one is the interesting one: found via Bazaar discovery, not marketing.
Worth keeping in your pocket rather than in the post — it reads as bragging if
volunteered, and as evidence if asked.

---

## Directory submissions

Only after the post is up. See [DISTRIBUTION.md](DISTRIBUTION.md) for the
per-directory notes and the awesome-x402 entry draft.

- [ ] x402scan.com — highest value, indexes settled volume
- [ ] agentic.market
- [ ] pay.sh
- [ ] app.ampersend.ai/discover
- [ ] awesome-x402 PR

Already listed automatically in PayAI's discovery index — no action needed.
