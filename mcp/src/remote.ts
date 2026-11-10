import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono, MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../../worker/src/api';
import { NEAR_RPC } from '../../worker/src/env';
import { httpReader } from './reader';
import type { PaymentDeps } from '../../worker/src/payments';
import { x402Payer } from './payers/x402';
import { toolServer } from './server';
import { makeTools } from './tools';
import type { ReinReader } from './types';

/** Each POST owns a fresh server and transport; no sessions or cross-request state. */
export function mountMcp(app: Hono<ApiEnv>, limitQuote: MiddlewareHandler<ApiEnv>): void {
  app.post('/mcp', limitQuote, async (c) => {
    // Views stay unsigned. Public API reads stay in-process, not a fetch back to this Worker.
    const base = httpReader(new URL(c.req.url).origin, NEAR_RPC[c.env.NEAR_NETWORK], c.env.DESK_ACCOUNT);
    let paymentDeps: PaymentDeps | undefined;
    const payments = async () => (paymentDeps ??= await c.env.deps.payments());
    async function api(path: string): Promise<unknown> {
      const response = await app.fetch(new Request(new URL(path, c.req.url)), c.env);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Rein API read failed (${response.status})`);
      return response.json();
    }
    const reader: ReinReader = {
      ...base,
      policy: async () => (await payments()).desk.policy(),
      getOrder: async (id) => (await payments()).desk.get_order(id),
      order: (id) => api(`/v1/orders/${id}`),
      async ledger(chain, limit = 200) {
        const network = chain ? (chain === 'base' || chain === 'monad' ? 'mainnet' : 'testnet') : c.env.NEAR_NETWORK;
        const data = (await api(`/v1/ledger?network=${network}`)) as { recent: { chain: string }[] };
        return { ...data, recent: data.recent.filter((p) => !chain || p.chain === chain).slice(0, limit) };
      },
      async nudge(id) {
        if (!(await c.env.deps.nudge(id))) throw new Error('no such order');
      },
    };
    const server = toolServer(
      makeTools(
        reader,
        {
          buy: async (chain, vault, payment) =>
            x402Payer(c.env, await payments(), new URL(c.req.url).origin).buy(chain, vault, payment),
        },
        {
          now: () => Date.now() / 1000,
          sleep(ms) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, ms);
            return promise;
          },
        },
      ),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    if (!response.body) {
      await server.close();
      return response;
    }
    const body = response.body.getReader();
    // Close only after the response stream ends: tool calls/progress may outlive handleRequest.
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await body.read();
            if (chunk.done) {
              await server.close();
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            await server.close();
            controller.error(error);
          }
        },
        async cancel(reason) {
          await body.cancel(reason);
          await server.close();
        },
      }),
      response,
    );
  });
}
