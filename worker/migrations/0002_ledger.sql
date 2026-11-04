-- Desk orders, copied from list_orders.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  payer TEXT,
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  amount TEXT NOT NULL,
  created_s INTEGER NOT NULL,
  status TEXT NOT NULL
);

-- Every doc the Worker had judged, by keccak256, so a post's stateHash leads back to its order and doc.
CREATE TABLE docs (
  hash TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL,
  doc TEXT NOT NULL
);

-- Oracle posts, copied from getPost, and their grading. uint256 values are decimal strings.
CREATE TABLE posts (
  chain TEXT NOT NULL,
  id INTEGER NOT NULL,
  vault TEXT NOT NULL,
  verdict INTEGER NOT NULL,
  confidence_bps INTEGER NOT NULL,
  risk_bps INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  pps_at_post TEXT NOT NULL,
  assets_at_post TEXT NOT NULL,
  liquidity_at_post TEXT NOT NULL,
  order_id INTEGER,
  -- Whether the doc's reading agrees with the oracle's own snapshot: match, mismatch or unknown.
  input_check TEXT NOT NULL DEFAULT 'unknown',
  -- 0 none, 1 first sample taken, 2 both taken.
  sampled INTEGER NOT NULL DEFAULT 0,
  resample_at INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0,
  adverse INTEGER,
  reasons INTEGER,
  PRIMARY KEY (chain, id)
);
CREATE INDEX posts_order ON posts (order_id);
CREATE INDEX posts_due ON posts (chain, resolved, posted_at);

-- Watch feed readings, one per menu vault per 600 s. Kept for a few hours.
CREATE TABLE watch_snapshots (
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  at INTEGER NOT NULL,
  apy_bps INTEGER,
  util_bps INTEGER NOT NULL,
  assets TEXT NOT NULL,
  PRIMARY KEY (chain, vault, at)
);

-- The reading each vault's moves are measured from: its first, or the one that last asked the desk for a watch order.
CREATE TABLE watch_baselines (
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  at INTEGER NOT NULL,
  apy_bps INTEGER,
  util_bps INTEGER NOT NULL,
  PRIMARY KEY (chain, vault)
);

-- Every watch order asked for, with the desk's order id or its refusal.
CREATE TABLE watch_requests (
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  order_id INTEGER,
  refusal TEXT
);

-- Small JSON values, such as the desk's last stats.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  at INTEGER NOT NULL
);
