-- Signed attempts are durable before broadcast, including sends whose response is lost.
CREATE TABLE broadcast_attempts (
  network TEXT NOT NULL,
  chain TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  hash TEXT NOT NULL,
  raw_tx TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network, chain, hash)
);
CREATE INDEX broadcast_attempts_order ON broadcast_attempts (network, chain, order_id);

-- An unresolved nonce cannot be allocated to a different order after a restart.
CREATE TABLE pending_nonces (
  network TEXT NOT NULL,
  chain TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  PRIMARY KEY (network, chain, nonce)
);
