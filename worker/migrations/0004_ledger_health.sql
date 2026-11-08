-- Published model cost is independent of account credits; NULL means not reported.
ALTER TABLE judge_calls ADD COLUMN stage TEXT;
ALTER TABLE judge_calls ADD COLUMN failure TEXT;
ALTER TABLE judge_calls ADD COLUMN tokens_in INTEGER;
ALTER TABLE judge_calls ADD COLUMN tokens_out INTEGER;
ALTER TABLE judge_calls ADD COLUMN credits_usd_micros INTEGER;
ALTER TABLE judge_calls ADD COLUMN model TEXT;
ALTER TABLE orders ADD COLUMN valid_until INTEGER;
ALTER TABLE orders ADD COLUMN exit_pending_s INTEGER;
ALTER TABLE orders ADD COLUMN delivered_s INTEGER;
ALTER TABLE posts ADD COLUMN resolved_at INTEGER;
ALTER TABLE broadcast_attempts ADD COLUMN gas_wei TEXT;
ALTER TABLE broadcast_attempts ADD COLUMN receipt_status TEXT;
CREATE TABLE quote_limits (
  ip_hash TEXT PRIMARY KEY,
  window_s INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  network TEXT NOT NULL,
  flag TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX incidents_active ON incidents (network, flag) WHERE resolved_at IS NULL;
-- Executor receipts do not overlap the desk's MPC-signed post fees.
CREATE TABLE executor_fees (
  chain TEXT NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  gas_wei TEXT NOT NULL,
  verdict_id INTEGER,
  PRIMARY KEY (chain, hash)
);
