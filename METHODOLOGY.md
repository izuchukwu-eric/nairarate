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

Official history is screened against neighbouring days; bands reconciled against mid.

## Validation

| | our mid | Monierate composite | variance |
|---|---|---|---|
| USD/NGN parallel | 1392.47 | 1397.82 | **0.4%** |

Independent methodologies, same market.
