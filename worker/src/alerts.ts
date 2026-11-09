import type { DeskChain } from '../../shared/desk';
import { NETWORK_CHAINS } from './deskTypes';
import type { Env, NearNetwork } from './env';

/** A browser's push subscription to one vault, as stored. */
export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  chain: string;
  vault: string;
}

/** What the service worker shows. Says what Rein called, never that a position was protected. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  chain: string;
  vault: string;
  verdict_id: number;
}

export interface AlertDeps {
  now: () => number;
  /** Sends one push and returns the push service's HTTP status. */
  send: (sub: PushSubscriptionRow, msg: PushMessage) => Promise<number>;
}

const SEND_BATCH = 50;
const MAX_ATTEMPTS = 5;
const CHAIN_LABEL: Record<DeskChain, string> = {
  base: 'Base',
  monad: 'Monad',
  'monad-testnet': 'Monad testnet',
  'base-sepolia': 'Base Sepolia',
};

/** Queues one delivery per subscription to this post's vault, if the post is an EXIT. Safe to repeat. */
export async function queueAlerts(db: D1Database, chain: DeskChain, verdictId: number): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO push_deliveries (subscription_id, chain, verdict_id, status)
      SELECT s.id, p.chain, p.id, 'queued' FROM posts p
      JOIN push_subscriptions s ON s.chain = p.chain AND s.vault = p.vault
      WHERE p.chain = ? AND p.id = ? AND p.verdict = 1`,
    )
    .bind(chain, verdictId)
    .run();
}

/** Sends queued EXIT alerts on the network's chains. A 404 or 410 means the browser unsubscribed: drop it. */
export async function sendAlerts(
  env: Env,
  network: NearNetwork,
  deps: AlertDeps,
): Promise<{ sent: number; failed: number }> {
  const chains = NETWORK_CHAINS[network];
  const { results } = await env.DB.prepare(
    `SELECT d.chain AS d_chain, d.verdict_id, d.attempts, s.id, s.endpoint, s.p256dh, s.auth, s.chain, s.vault,
        p.confidence_bps, p.order_id
      FROM push_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id
      JOIN posts p ON p.chain = d.chain AND p.id = d.verdict_id
      WHERE d.status = 'queued' AND d.chain IN (${chains.map(() => '?').join(', ')})
      ORDER BY d.verdict_id LIMIT ?`,
  )
    .bind(...chains, SEND_BATCH)
    .all<
      PushSubscriptionRow & {
        d_chain: DeskChain;
        verdict_id: number;
        attempts: number;
        confidence_bps: number;
        order_id: number | null;
      }
    >();
  const tally = { sent: 0, failed: 0 };
  for (const r of results) {
    const msg: PushMessage = {
      title: `Rein called EXIT on ${CHAIN_LABEL[r.d_chain]}`,
      body:
        `Vault ${r.vault.slice(0, 6)}…${r.vault.slice(-4)}, ${(r.confidence_bps / 100).toFixed(0)}% confidence. ` +
        'This is a signal only: check your position.',
      url: r.order_id === null ? '/ledger' : `/orders/${r.order_id}`,
      chain: r.d_chain,
      vault: r.vault,
      verdict_id: r.verdict_id,
    };
    // A network error counts as a failed attempt, like a 5xx.
    const status = await deps.send(r, msg).catch(() => 0);
    const key = [r.id, r.d_chain, r.verdict_id] as const;
    if (status >= 200 && status < 300) {
      tally.sent++;
      await env.DB.prepare(
        `UPDATE push_deliveries SET status = 'sent', attempts = attempts + 1, sent_at = ?
        WHERE subscription_id = ? AND chain = ? AND verdict_id = ?`,
      )
        .bind(deps.now(), ...key)
        .run();
    } else if (status === 404 || status === 410) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE push_deliveries SET status = 'gone' WHERE subscription_id = ?`).bind(r.id),
        env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(r.id),
      ]);
    } else {
      tally.failed++;
      await env.DB.prepare(
        `UPDATE push_deliveries SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END
        WHERE subscription_id = ? AND chain = ? AND verdict_id = ?`,
      )
        .bind(MAX_ATTEMPTS, ...key)
        .run();
    }
  }
  return tally;
}

// --- Web Push: RFC 8291 message encryption and RFC 8292 VAPID, on WebCrypto. ---

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
export const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Encrypts `plaintext` for one subscription: the aes128gcm body of RFC 8188 with RFC 8291's key schedule. */
export async function encryptPush(p256dh: string, auth: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64u(p256dh);
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      as.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(fromB64u(auth), secret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the plaintext, then the 0x02 delimiter that marks it as the last.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))),
  );
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/** A VAPID Authorization header for the push service at `endpoint`, signed with the Worker's VAPID key. */
export async function vapidAuth(endpoint: string, publicKey: string, privateKey: string, subject: string, now: number) {
  const pub = fromB64u(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o: object) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

/** Sends through each browser's push service. Off (null) until the VAPID keys are set as Worker secrets. */
export function realAlertDeps(env: Env): AlertDeps | null {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = env;
  if (!pub || !priv) return null;
  const subject = env.VAPID_SUBJECT || 'https://reinfi.xyz';
  return {
    now: () => Math.floor(Date.now() / 1000),
    send: async (sub, msg) => {
      const body = await encryptPush(sub.p256dh, sub.auth, enc.encode(JSON.stringify(msg)));
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuth(sub.endpoint, pub, priv, subject, Math.floor(Date.now() / 1000)),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '3600',
          Urgency: 'high',
        },
        body,
      });
      return res.status;
    },
  };
}

const MAX_PER_ENDPOINT = 20;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Parses a subscribe or unsubscribe body: the browser's PushSubscription JSON plus the vault it's about. */
function parseSubscription(body: unknown, network: NearNetwork) {
  const b = body as {
    subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    chain?: unknown;
    vault?: unknown;
  };
  const endpoint = b?.subscription?.endpoint;
  const { p256dh, auth } = b?.subscription?.keys ?? {};
  const vault = typeof b?.vault === 'string' ? b.vault.toLowerCase() : '';
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !endpoint.startsWith('https://')) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 128 || auth.length > 64) return null;
  if (!(NETWORK_CHAINS[network] as string[]).includes(b.chain as string) || !ADDRESS.test(vault)) return null;
  return { endpoint, p256dh, auth, chain: b.chain as string, vault };
}

/** POST /v1/alerts/subscribe and /v1/alerts/unsubscribe. */
export async function changeSubscription(
  db: D1Database,
  network: NearNetwork,
  body: unknown,
  on: boolean,
  now: number,
) {
  const s = parseSubscription(body, network);
  if (!s)
    return { status: 400, body: { error: 'need subscription {endpoint, keys}, a chain on this network and a vault' } };
  if (!on) {
    await db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND chain = ? AND vault = ?')
      .bind(s.endpoint, s.chain, s.vault)
      .run();
    return { status: 200, body: { subscribed: false } };
  }
  const n = await db
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?')
    .bind(s.endpoint)
    .first<number>('n');
  if ((n ?? 0) >= MAX_PER_ENDPOINT)
    return { status: 429, body: { error: `at most ${MAX_PER_ENDPOINT} vaults per browser` } };
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, chain, vault, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (endpoint, chain, vault) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(s.endpoint, s.p256dh, s.auth, s.chain, s.vault, now)
    .run();
  return { status: 200, body: { subscribed: true } };
}
