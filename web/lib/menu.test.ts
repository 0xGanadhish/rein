import { describe, expect, it } from 'vitest';
import { buildMenu, menuNote, paymentCall } from './menu';

const VAULT = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const policy = { priceNear: '300000000000000000000000', priceUsdc: '1000000', usdcToken: 'usdc.testnet', deadlineS: 3600, spacingS: 600, kill: false };
const sel = { chain: 'monad-testnet' as const, vault: '0x00000000000000000000000000000000000000AA' };

describe('menu', () => {
  it('menu_shows_latest_verdict_and_next_allowed_time', () => {
    const now = 10_000;
    const menu = buildMenu({
      entries: [{ chain: 'monad-testnet', vault: VAULT }, { chain: 'monad-testnet', vault: OTHER }],
      recent: [
        { chain: 'monad-testnet', vault: VAULT, verdict: 'EXIT', posted_at: now - 100 },
        { chain: 'monad-testnet', vault: VAULT, verdict: 'HOLD', posted_at: now - 5_000 },
        { chain: 'monad-testnet', vault: OTHER, verdict: 'HOLD', posted_at: now - 5_000 },
      ],
      spacingS: 600,
      nowS: now,
    });
    const a = menu.find((v) => v.vault === VAULT)!;
    const b = menu.find((v) => v.vault === OTHER)!;
    expect(a).toMatchObject({ last: 'EXIT', nextAt: now + 500 });
    expect(b).toMatchObject({ last: 'HOLD', nextAt: null });
    expect(menuNote(a)).toBe(`last call EXIT · next from ${new Date((now + 500) * 1000).toISOString().slice(11, 16)} UTC`);
    expect(menuNote(b)).toBe('last call HOLD');
  });

  it('pay_with_near_calls_request_judgement_with_the_price', () => {
    expect(paymentCall('near', sel, policy, 'desk.testnet')).toEqual({
      receiverId: 'desk.testnet', methodName: 'request_judgement', deposit: policy.priceNear,
      args: { chain: 'monad-testnet', vault: VAULT },
    });
  });

  it('pay_with_usdc_calls_ft_transfer_call_with_the_msg_json', () => {
    expect(paymentCall('usdc', sel, policy, 'desk.testnet')).toEqual({
      receiverId: 'usdc.testnet', methodName: 'ft_transfer_call', deposit: '1',
      args: { receiver_id: 'desk.testnet', amount: '1000000', msg: JSON.stringify({ chain: 'monad-testnet', vault: VAULT }) },
    });
  });
});
