-- nairarate D1 schema
--
-- Two tables, deliberately:
--
--   rate_snapshots  intraday observations from the 15-minute Monierate sync.
--                   Append-only, high churn, pruned at 30 days. Feeds the
--                   daily roll-up; never read on the request path.
--
--   rate_daily      one row per (source, currency, market, date). Composite
--                   primary key so backfills and cron re-runs are idempotent
--                   via INSERT OR REPLACE. This is the only table /v1/rates/history
--                   reads.
--
-- Rate direction is normalised to bid/ask across both sources, because the
-- upstreams disagree: CBN's `buyingrate` is the LOW side while Monierate's `buy`
-- is the HIGH side. Storing either source's own field names would give the same
-- column opposite meanings depending on `source`. Invariant here: bid <= ask.

CREATE TABLE IF NOT EXISTS rate_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL,       -- 'monierate' | 'cbn'
  currency       TEXT NOT NULL,       -- ISO 4217, or USDT/USDC
  market         TEXT NOT NULL,       -- 'official' | 'parallel' | 'crypto_street'
  bid            REAL,               -- NGN received per unit FX (lower side)
  ask            REAL,               -- NGN paid per unit FX (higher side)
  mid            REAL,
  provider_count INTEGER,             -- platforms quoting this pair at fetch time
  fetched_at     INTEGER NOT NULL,    -- unix seconds
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_snapshots_currency_market
  ON rate_snapshots(currency, market, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_fetched_at
  ON rate_snapshots(fetched_at DESC);

CREATE TABLE IF NOT EXISTS rate_daily (
  source         TEXT NOT NULL,       -- 'cbn' | 'monierate'
  currency       TEXT NOT NULL,
  market         TEXT NOT NULL,
  rate_date      TEXT NOT NULL,       -- 'YYYY-MM-DD'
  bid            REAL,               -- NGN received per unit FX (lower side)
  ask            REAL,               -- NGN paid per unit FX (higher side)
  mid            REAL,                -- canonical rate for the day
  open           REAL,
  high           REAL,
  low            REAL,
  close          REAL,
  -- NFEM-only market-depth fields. Null for every other series; these are the
  -- differentiator on USD official and worth carrying through to /history.
  turnover       REAL,                -- NFEM total turnover, USD
  deal_count     INTEGER,             -- number of deals at NFEM
  provider_count INTEGER,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source, currency, market, rate_date)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_currency_market
  ON rate_daily(currency, market, rate_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_date
  ON rate_daily(rate_date DESC);
