import { Account } from '@near-js/accounts';
import type { KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { DeskPolicy } from '../../../shared/desk';
import { deskView } from '../reader';
import type { Payer } from '../types';

export function nearPayer(cfg: { rpcUrl: string; desk: string; account: string; key: string }): Payer {
  // Lazy parsing lets free tools run without loading or using the signing key.
  let account: Account | undefined;
  return {
    async buy(chain, vault) {
      try {
        const policy = await deskView<DeskPolicy>(cfg.rpcUrl, cfg.desk, 'policy');
        if (!account) {
          account = new Account(
            cfg.account,
            new JsonRpcProvider({ url: cfg.rpcUrl }, { retries: 1 }),
            KeyPairSigner.fromSecretKey(cfg.key as KeyPairString),
          );
        }
        const orderId = await account.callFunction({
          contractId: cfg.desk,
          methodName: 'request_judgement',
          args: { chain, vault },
          deposit: BigInt(policy.price_near),
          gas: 30_000_000_000_000n,
        });
        if (!Number.isSafeInteger(orderId) || Number(orderId) < 0) throw new Error('Desk returned an invalid order_id');
        return { orderId: Number(orderId) };
      } catch (error) {
        let message = error instanceof Error ? error.message : 'NEAR request failed';
        for (const secret of [cfg.key, cfg.key.split(':').at(-1) ?? '']) {
          if (secret) message = message.split(secret).join('[redacted]');
        }
        const refused = /Smart contract panicked:\s*([^\n]+)/.exec(message)?.[1];
        if (refused) return { refused: refused.slice(0, 200) };
        // Do not retain the original Error as a cause: it may contain key material.
        // eslint-disable-next-line preserve-caught-error -- The original cause can expose the buyer's secret.
        throw new Error(message);
      }
    },
  };
}
