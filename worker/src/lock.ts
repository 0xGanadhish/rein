/**
 * Runs `fn` while holding the D1 lock row `key`, or not at all if another runner holds it. A holder that dies leaves
 * the row behind; it frees itself `ttlS` seconds after it was taken.
 */
export async function withLock<T>(db: D1Database, key: string, ttlS: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const now = Math.floor(Date.now() / 1000);
  const holder = crypto.randomUUID();
  const taken = await db.prepare(`INSERT INTO locks (key, holder, expires_at) VALUES (?1, ?2, ?3)
      ON CONFLICT (key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE locks.expires_at <= ?4`)
    .bind(key, holder, now + ttlS, now).run();
  if (taken.meta.changes !== 1) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await db.prepare('DELETE FROM locks WHERE key = ? AND holder = ?').bind(key, holder).run();
  }
}
