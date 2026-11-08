/**
 * Runs `fn` while holding the D1 lock row `key`, renewing it during long work. A holder that dies leaves
 * the row behind; it frees itself `ttlS` seconds after the last renewal.
 */
export async function withLock<T>(
  db: D1Database,
  key: string,
  ttlS: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const now = Math.floor(Date.now() / 1000);
  const holder = crypto.randomUUID();
  const taken = await db
    .prepare(
      `INSERT INTO locks (key, holder, expires_at) VALUES (?1, ?2, ?3)
      ON CONFLICT (key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE locks.expires_at <= ?4`,
    )
    .bind(key, holder, now + ttlS, now)
    .run();
  if (taken.meta.changes !== 1) return { ran: false };
  let renewal = Promise.resolve();
  let renewalError: unknown;
  const timer = setInterval(
    () => {
      renewal = renewal.then(async () => {
        try {
          const at = Math.floor(Date.now() / 1000);
          const renewed = await db
            .prepare('UPDATE locks SET expires_at = ? WHERE key = ? AND holder = ?')
            .bind(at + ttlS, key, holder)
            .run();
          if (renewed.meta.changes !== 1) throw new Error(`lease lost: ${key}`);
        } catch (e) {
          renewalError = e;
        }
      });
    },
    (ttlS * 1000) / 3,
  );
  let value: T;
  try {
    value = await fn();
  } finally {
    clearInterval(timer);
    await renewal;
    await db.prepare('DELETE FROM locks WHERE key = ? AND holder = ?').bind(key, holder).run();
  }
  if (renewalError) throw renewalError;
  return { ran: true, value };
}
