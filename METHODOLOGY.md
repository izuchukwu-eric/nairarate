# Methodology

How these rates are derived, so you can decide whether to trust them.

## Sources

**Official** — CBN's JSON endpoints. USD uses the NFEM volume-weighted average, CBN's stated official rate.

**Parallel / street** — every changer quoting a pair via Monierate `platforms.json`, aggregated here rather than taken pre-blended.

## Screening

Unfiltered, USD returns a mid of **1181** against a true ~1392. Four exclusions:

| Exclusion | Reason |
|---|---|
| `buy: 0` as no-quote | Remittance corridors publish one side; 19 of 65 USD platforms. The zero halves the mid |
| `cbn` | The central bank — drags parallel toward official, understating the spread |
| `fastforex`, `cambridge_currencies` | Reference/institutional feeds, not street rates |
| `monierate-fx` | Quoted GBP at 130 against a ~1850 market |

Survivors are aggregated by **median**, not mean — robust to the long tail of outlying changers. Quotes >3× from peer median are dropped. `provider_count` reports surviving quotes, so a rate resting on one platform is visible as such.

## Historical screening

Both historical sources carry upstream errors, and both are screened before
ingest. The test is **locality**: real devaluation is gradual, so a value multiples
away from the median of its neighbouring days is an error, not a market event. A
global bound cannot work — the naira genuinely went from ~₦130/$ to ~₦1,360/$ since
2001.

The two sources need different thresholds, and both were measured rather than guessed:

| series | threshold | why | rejected |
|---|---|---|---|
| CBN official (2001→) | **5×** | Errors are decimal slips — a Danish krone published at 198,024 against a ~200 baseline | 27 of 51,055 |
| Daily FX candles | **2.5×** | Errors are ~3× | 3 of 4,252 |

On the daily series the two populations separate cleanly. The largest **genuine**
deviation across all 4,252 rows is **1.13×**. The bad rows sit at **3.17–5.4×** — and
all three share one date, 2025-10-01, an upstream incident affecting USD, USDT and
USDC simultaneously. 5× caught only the worst of them, which is why the daily
threshold is tighter.

2.5× is not the midpoint of what we observed; it is deliberately above the **~1.63×**
single-day move of the June 2023 naira float. That float predates this dataset, so
it does not appear in the 1.13× figure — but a repeat would be a real market event,
and it must not be screened out as an error.

Two-sided bands are reconciled against the mid, which both sources publish
directly. CBN carries 31 rows where its buying rate exceeds its selling rate — JPY
on 2016-11-01 has a bid of 29,009 against a mid of 2.9057. The mid is trusted and
only the incoherent side is dropped, so the row keeps its usable value.

## Validation

| | our mid | Monierate composite | variance |
|---|---|---|---|
| USD/NGN parallel | 1392.47 | 1397.82 | **0.4%** |

Independent methodologies, same market.
