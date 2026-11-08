import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWithNonceRetry } from '../src/nearNonce';

afterEach(() => { vi.useRealTimers(); });

describe('NEAR mutation nonce recovery', () => {
  it('independent concurrent mutations recover a rejected nonce without replaying uncertain effects', async () => {
    vi.useFakeTimers();
    let nonce = 10n;
    let initialReads = 0;
    const concurrentReads = Promise.withResolvers<void>();
    const effects: string[] = [];
    const attempts: Record<string, number> = {};

    // Model Account.createTransaction's access-key read then nonce + 2 selection.
    // Separate callers share only the remote key, not a local queue or Account.
    const mutate = async (id: string) => {
      attempts[id] = (attempts[id] ?? 0) + 1;
      const selected = nonce + 2n;
      if (attempts[id] === 1) {
        if (++initialReads === 2) concurrentReads.resolve();
        await concurrentReads.promise;
      }
      if (selected <= nonce) {
        throw Object.assign(new Error('Transaction nonce must be larger than access key nonce'), {
          type: 'InvalidNonce', tx_nonce: selected.toString(), ak_nonce: nonce.toString(),
        });
      }
      nonce = selected;
      effects.push(id);
      return id;
    };

    const results = Promise.all([
      callWithNonceRetry(() => mutate('cron')),
      callWithNonceRetry(() => mutate('x402')),
    ]);
    await vi.runAllTimersAsync();
    expect(await results).toEqual(['cron', 'x402']);
    expect(effects).toEqual(['cron', 'x402']);
    expect(attempts).toEqual({ cron: 1, x402: 2 });

    // A lost response can hide successful execution: never sign a replacement.
    const lostResponse = new Error('Failed to fetch after submission');
    let uncertainAttempts = 0;
    await expect(callWithNonceRetry(async () => {
      uncertainAttempts++;
      effects.push('uncertain');
      throw lostResponse;
    })).rejects.toBe(lostResponse);
    expect(uncertainAttempts).toBe(1);
    expect(effects.filter((id) => id === 'uncertain')).toHaveLength(1);

    // Message text is not an explicit RPC rejection classification.
    const unclassified = new Error('InvalidNonce');
    let unclassifiedAttempts = 0;
    await expect(callWithNonceRetry(async () => {
      unclassifiedAttempts++;
      throw unclassified;
    })).rejects.toBe(unclassified);
    expect(unclassifiedAttempts).toBe(1);

    // A nonce that is too large is not the stale-key collision this recovers.
    const tooLarge = Object.assign(new Error('nonce too large'), { type: 'NonceTooLarge' });
    let tooLargeAttempts = 0;
    await expect(callWithNonceRetry(async () => {
      tooLargeAttempts++;
      throw tooLarge;
    })).rejects.toBe(tooLarge);
    expect(tooLargeAttempts).toBe(1);
  });
});
