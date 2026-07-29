# Distribution

Nothing here happens until [DEPLOY.md](DEPLOY.md) step 10 is green — a real
mainnet settlement, verified on Basescan.

---

## 0. Discovery — done

The ecosystem has converged on machine-readable discovery, and all of it is now
implemented and verified live:

| Convention | Status |
|---|---|
| **Bazaar extension** | Declared per-route. Confirmed reaching the 402 challenge as `extensions.bazaar`, with `method` derived by `enrichDeclaration`. |
| `/.well-known/x402` | Service manifest — endpoints, prices, network, per-currency coverage. |
| `/llms.txt` | Plain-text description for agents, explicit about coverage gaps. |
| `/openapi.json` | OpenAPI 3.1, all `$ref`s resolve. |
| `/methodology` | The screening rules as plain text. |

All five are free and unauthenticated — an agent cannot decide to pay for something
it cannot first read about. All are generated from the currency registry and
payment constants, so they cannot drift from what is served.

**The PayAI/Bazaar question is settled: PayAI participates and is not CDP-coupled.**
`GET facilitator.payai.network/discovery/resources` returns 100 live resources with
`accepts`, `resource`, `inputSchema`/`outputSchema` and `lastUpdated`, including
`eip155:8453` v2 entries. x402.org's testnet facilitator has no equivalent endpoint
(404), so mainnet indexing rides on PayAI — which is where we settle anyway. No
Coinbase dependency was introduced.

`/.well-known/agent.json` (agent card) is still absent. Skipped for v1: it is an
A2A convention rather than an x402 one, and none of the four target directories
appear to read it.

---

## 1. Directories

All four confirmed live (HTTP 200, titles as shown).

| Site | Notes |
|---|---|
| **[x402scan.com](https://x402scan.com)** — *x402scan \| x402 Ecosystem Explorer* | Highest value: it indexes real settled volume, so listings carry evidence rather than claims. Has an explicit `/resources/register` route plus an "Add your API" CTA. Bazaar-backed — see section 0. |
| **[agentic.market](https://agentic.market)** — *Agentic Market* | |
| **[pay.sh](https://pay.sh)** — *Agentic payments for API \| pay.sh* | |
| **[app.ampersend.ai/discover](https://app.ampersend.ai/discover)** — *ampersend \| Marketplace — Pay-per-use AI services* | |

## 2. awesome-x402

PR-based. `github.com/xpaysh/awesome-x402` has a `CONTRIBUTING.md` (confirmed
present) and a Contributing section in the README.

Read CONTRIBUTING.md before opening the PR. From the existing entries, the house
style is one line: name, link, what it does, price, network, then bracketed
discovery links. Note how thoroughly the existing entries are stuffed with
endpoint counts — the differentiator here is **not** breadth.

Draft entry:

```markdown
- [nairarate.dev](https://nairarate.dev) — Nigerian FX intelligence across three
  markets in one call: the CBN official rate, the parallel ("black market") rate,
  and USDT/USDC street prices, with the spreads between them, 7-day trends and a
  freshness-based confidence score. Parallel rates are aggregated from 40+
  changers with the central bank and reference feeds screened out (see
  [methodology](https://nairarate.dev/methodology)); official series reach back to
  2001. 15 currencies. $0.03/call for live rates, $0.05 for historical, USDC on
  Base. No API keys, no signup. Free `/health` for source freshness before you pay.
```

## 3. Positioning

Most listings compete on breadth — "43 APIs", "117 MCP tools", "100 x402 APIs".
Competing there is pointless. Two things are actually defensible:

1. **The data exists nowhere else as an API.** No global FX provider publishes NGN
   parallel or USDT/NGN street rates. Frankfurter and ExchangeRate-API carry the
   official mid only. That is the whole pitch and it should lead every listing.
2. **The methodology is auditable.** Naive aggregation of the same upstream gives a
   USD mid of 1181 against a true ~1392. Publishing what was screened out, and why,
   is a real trust claim — a competitor scraping the same source will get the wrong
   number. Link [METHODOLOGY.md](METHODOLOGY.md) everywhere.

Secondary hook for the x402 audience specifically: **USDC/NGN is the rate x402
callers are themselves exposed to.** Agents paying in USDC on Base and operating
anywhere near Nigeria are pricing their own settlement currency. No other listing
covers that.

## 4. Launch post

Lead with the number, not the architecture. The spread is the product.

```
No FX API publishes Nigeria's parallel market rate. So I built one.

nairarate.dev returns all three NGN markets in one call — CBN official,
parallel, and USDT/USDC street price — plus the spreads between them.

Today: official ₦1365.53, parallel ₦1392.80. A 2.0% spread that no
mainstream FX API shows you.

$0.03 per call in USDC on Base via x402. No API key, no signup.

  curl https://nairarate.dev/v1/rates

Freshness is free before you pay:

  curl https://nairarate.dev/health
```

Notes:

- **Re-run the numbers before posting.** Those are from 2026-07-28 and move daily;
  a stale spread in a launch post about rate accuracy is the worst possible error.
  `curl https://nairarate.dev/health` then pull a live `/v1/rates`.
- The free `/health` curl is the strongest line in it — it is a verifiable claim a
  reader can run immediately, with no wallet and no signup.
- Follow-up post, once there is a week of history: the 7-day spread trend. A chart
  of `parallel_vs_official_pct` over time is the thing nobody else can publish, and
  it advertises `/history` (the $0.05 endpoint) rather than the $0.03 one.
- Worth a mention in the thread, not the main post: the 24-year official backfill.
  It is a strong credibility signal but a weak hook.
