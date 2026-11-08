-- D1 is the exit queue: discovery, fan-out, signed attempts and follow-up deadlines survive restarts.
CREATE TABLE guardian_scans (
  chain TEXT PRIMARY KEY,
  guardian TEXT NOT NULL,
  next_block INTEGER NOT NULL
);
CREATE TABLE guardian_owners (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  owner TEXT NOT NULL,
  UNIQUE (chain, vault, owner)
);
CREATE TABLE exit_verdicts (
  chain TEXT NOT NULL,
  verdict_id INTEGER NOT NULL,
  owner_cursor INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, verdict_id)
);
CREATE TABLE exits (
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  owner TEXT NOT NULL,
  verdict_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'partial', 'confirmed', 'skipped', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  assets TEXT,
  remaining_shares TEXT,
  error TEXT,
  PRIMARY KEY (chain, vault, owner, verdict_id)
);
CREATE INDEX exits_due ON exits (chain, next_at);
CREATE TABLE exit_attempts (
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  owner TEXT NOT NULL,
  verdict_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  raw_tx TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, vault, owner, verdict_id, attempt),
  UNIQUE (chain, tx_hash)
);
CREATE UNIQUE INDEX exit_pending_nonce ON exit_attempts (chain) WHERE settled = 0;
