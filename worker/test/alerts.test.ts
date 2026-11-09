import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { DeskStats } from '../../shared/desk';
import { sendAlerts, type AlertDeps, type PushMessage, type PushSubscriptionRow } from '../src/alerts';
import { mirror, type MirrorDeps, type OraclePost } from '../src/mirror';

const NOW = 1_793_774_225;
const VAULT = '0x00000000000000000000000000000000000000aa' as const;
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

/** A mirror that sees `posts` on Monad testnet's oracle, appended to as the test goes. */
function mirrorOf(posts: { vault: `0x${string}`; verdict: number }[]): MirrorDeps {
  const desk = {
    open_orders: async () => [],
    list_orders: async () => [],
    next_order_id: async () => 0,
    stats: async () => ({}) as DeskStats,
  };
  return {
    desk,
    oracle: (chain) =>
      chain !== 'monad-testnet'
        ? null
        : {
            postCount: async () => BigInt(posts.length),
            getPost: async (id): Promise<OraclePost> => ({
              ...posts[Number(id) - 1]!,
              confidenceBps: 8200,
              riskBps: 9500,
              stateHash: `0x${String(id).padStart(64, '0')}`,
              postedAt: BigInt(NOW),
              ppsAtPost: 1n,
              assetsAtPost: 1n,
              liquidityAtPost: 1n,
            }),
          },
  };
}

function sender() {
  const sent: { sub: PushSubscriptionRow; msg: PushMessage }[] = [];
  const deps: AlertDeps = {
    now: () => NOW,
    send: async (sub, msg) => {
      sent.push({ sub, msg });
      return 201;
    },
  };
  return { sent, deps };
}

const subscribe = (endpoint: string, chain: string, vault: string) =>
  env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, chain, vault, created_at) VALUES (?, 'k', 'a', ?, ?, ?)`,
  )
    .bind(endpoint, chain, vault, NOW)
    .run();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch(
    ['cursors', 'posts', 'docs', 'meta', 'exit_verdicts', 'push_subscriptions', 'push_deliveries'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

it('exit_alert_sent_once_per_verdict', async () => {
  await subscribe('https://push.test/a', 'monad-testnet', VAULT);
  const posts = [{ vault: VAULT, verdict: 1 }];
  const { sent, deps } = sender();

  await mirror(env, 'testnet', mirrorOf(posts), NOW);
  await sendAlerts(env, 'testnet', deps);
  // The mirror and the sender run again every minute; a second EXIT is a new verdict and alerts again.
  await env.DB.prepare('DELETE FROM cursors').run();
  await mirror(env, 'testnet', mirrorOf(posts), NOW);
  await sendAlerts(env, 'testnet', deps);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.msg).toMatchObject({ chain: 'monad-testnet', vault: VAULT, verdict_id: 1 });
  expect(sent[0]!.msg.body).not.toMatch(/protect|safe|secured/i);

  posts.push({ vault: VAULT, verdict: 1 });
  await mirror(env, 'testnet', mirrorOf(posts), NOW);
  await sendAlerts(env, 'testnet', deps);
  expect(sent.map((s) => s.msg.verdict_id)).toEqual([1, 2]);
});

it('exit_alert_only_to_subscribers', async () => {
  await subscribe('https://push.test/vault', 'monad-testnet', VAULT);
  await subscribe('https://push.test/other-vault', 'monad-testnet', OTHER);
  await subscribe('https://push.test/other-chain', 'base-sepolia', VAULT);
  // A HOLD on the subscribed vault, then an EXIT on it.
  const { sent, deps } = sender();
  await mirror(
    env,
    'testnet',
    mirrorOf([
      { vault: VAULT, verdict: 0 },
      { vault: VAULT, verdict: 1 },
    ]),
    NOW,
  );
  await sendAlerts(env, 'testnet', deps);
  expect(sent.map((s) => [s.sub.endpoint, s.msg.verdict_id])).toEqual([['https://push.test/vault', 2]]);

  // A browser that unsubscribed (the push service answers 410) is dropped, not retried.
  await subscribe('https://push.test/gone', 'monad-testnet', VAULT);
  const gone = sender();
  gone.deps.send = async (sub, msg) => {
    gone.sent.push({ sub, msg });
    return 410;
  };
  await env.DB.prepare('DELETE FROM cursors').run();
  await mirror(
    env,
    'testnet',
    mirrorOf([
      { vault: VAULT, verdict: 0 },
      { vault: VAULT, verdict: 1 },
    ]),
    NOW,
  );
  await sendAlerts(env, 'testnet', gone.deps);
  await sendAlerts(env, 'testnet', gone.deps);
  expect(gone.sent.map((s) => s.sub.endpoint)).toEqual(['https://push.test/gone']);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?')
      .bind('https://push.test/gone')
      .first('n'),
  ).toBe(0);
});
