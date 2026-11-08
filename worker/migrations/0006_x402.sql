-- One payment instrument, one purchase, at most one free replacement judgement.
CREATE TABLE x402_payments (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  origin_network TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deposit_memo TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  amount TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  refund_deadline TEXT NOT NULL,
  settlement_status TEXT NOT NULL DEFAULT 'quoted' CHECK (settlement_status IN ('quoted', 'pending', 'settled', 'failed')),
  settlement_json TEXT,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'running', 'credit', 'delivered', 'exhausted')),
  credit_used INTEGER NOT NULL DEFAULT 0 CHECK (credit_used IN (0, 1)),
  result_json TEXT,
  result_status INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (network, origin_network, deposit_address, deposit_memo)
);

-- The reference for each attempt is also deduplicated by the desk, including after pruning.
CREATE TABLE x402_attempts (
  payment_id TEXT NOT NULL REFERENCES x402_payments(id),
  attempt INTEGER NOT NULL CHECK (attempt IN (0, 1)),
  amount TEXT NOT NULL,
  order_id INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'opening' CHECK (status IN ('opening', 'open', 'delivered', 'failed')),
  PRIMARY KEY (payment_id, attempt)
);
CREATE INDEX x402_payments_pending ON x402_payments (network, settlement_status, state);
