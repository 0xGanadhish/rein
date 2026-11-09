-- Web push for EXIT calls. A browser subscribes to one vault on one chain; each EXIT post on that vault queues one
-- delivery per subscription, and the primary key keeps it to one per verdict however often the mirror repeats.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  chain TEXT NOT NULL,
  vault TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (endpoint, chain, vault)
);
CREATE INDEX push_subscriptions_vault ON push_subscriptions (chain, vault);
CREATE TABLE push_deliveries (
  subscription_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  verdict_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'gone', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  PRIMARY KEY (subscription_id, chain, verdict_id)
);
CREATE INDEX push_deliveries_queued ON push_deliveries (status) WHERE status = 'queued';
