# Distribution

Nothing here happens until [DEPLOY.md](DEPLOY.md) step 10 is green — a real
mainnet settlement, verified on Basescan.

---

## 0. Prerequisite: we are not discoverable yet

Worth knowing before submitting anywhere. Reading how the existing awesome-x402
listings describe themselves, this ecosystem has settled on a set of
machine-readable discovery conventions, and **we implement none of them**:

| Convention | What it is | Status |
|---|---|---|
| **Bazaar extension** | The x402 protocol's own discovery layer. Declared per-route via `extensions.bazaar`; `@x402/extensions/bazaar` is already an installed dependency (`withBazaar`, `declareDiscoveryExtension`). | **Not declared** |
| `/.well-known/x402` | Static manifest of endpoints, prices, networks. Most listings advertise one. | Missing |
| `/llms.txt` | Plain-text description for agents and LLM crawlers. | Missing |
| `/openapi.json` | OpenAPI 3 spec. | Missing |
| `/.well-known/agent.json` | Agent card. | Missing |

**Bazaar is the important one.** x402scan's own front page queries a
`sellers.bazaar.featured` collection — Bazaar is its index source, so declaring it
is how a service gets picked up automatically rather than only by manual
submission. Several listings mention routing settlement through a specific
facilitator "for Bazaar indexing", so it is worth confirming PayAI participates in
Bazaar before assuming auto-indexing follows from the declaration alone.

Recommended order: declare Bazaar and add `/.well-known/x402` + `/llms.txt`
(roughly half a day together), **then** submit. Submitting first means the manual
listings are all we get.

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
  2001. 15 currencies. $0.002/call for live rates, $0.01 for historical, USDC on
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

$0.002 per call in USDC on Base via x402. No API key, no signup.

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
  it advertises `/history` (the $0.01 endpoint) rather than the $0.002 one.
- Worth a mention in the thread, not the main post: the 24-year official backfill.
  It is a strong credibility signal but a weak hook.
