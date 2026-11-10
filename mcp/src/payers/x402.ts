import { DEPLOYMENTS } from '../../../shared/deployments';
import type { Env } from '../../../worker/src/env';
import { x402Judge, type PaymentDeps } from '../../../worker/src/payments';
import type { Payer } from '../types';

/** `origin` is the Worker's own origin, so requirements and payments name the same resource as `/v1/x402/judge`. */
export function x402Payer(env: Env, deps: PaymentDeps, origin = DEPLOYMENTS[env.NEAR_NETWORK].api): Payer {
  return {
    async buy(chain, vault, payment) {
      const response = await x402Judge(
        new Request(new URL('/v1/x402/judge', origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(payment ? { 'PAYMENT-SIGNATURE': payment } : {}) },
          body: JSON.stringify({ chain, vault }),
        }),
        env,
        deps,
      );
      const body = (await response.json()) as {
        orderId?: number;
        accepts?: unknown[];
        error?: string;
        status?: string;
        paymentRef?: string;
      };
      if (response.status === 402) return { paymentRequired: true, accepts: body.accepts ?? [] };
      if (response.status === 422) return { refused: body.error ?? 'Judgement refused' };
      if (
        (response.status === 200 || response.status === 202 || body.error === 'not signed in time') &&
        Number.isSafeInteger(body.orderId)
      )
        return { orderId: body.orderId! };
      if (response.status === 202 && body.status === 'pending' && body.paymentRef)
        return { paymentPending: true, paymentRef: body.paymentRef };
      throw new Error(body.error ?? `x402 judgement failed (${response.status})`);
    },
  };
}
