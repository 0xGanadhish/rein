-- One runner per key (a chain) at a time. A row past expires_at is free to take.
CREATE TABLE locks (
  key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Small persistent values, such as the lowest order id that may still need work.
CREATE TABLE cursors (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- What each NEAR AI call cost, for the Ledger's unit economics.
CREATE TABLE judge_calls (
  order_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  signing_address TEXT NOT NULL,
  cost_usd_micros INTEGER NOT NULL
);
CREATE INDEX judge_calls_order ON judge_calls (order_id);
