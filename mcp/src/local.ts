#!/usr/bin/env -S npx --no-install tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEPLOYMENTS } from '../../shared/deployments';
import { nearPayer } from './payers/near';
import { httpReader } from './reader';
import { toolServer } from './server';
import { makeTools } from './tools';

async function main() {
  for (const name of ['REIN_NETWORK', 'REIN_NEAR_ACCOUNT', 'REIN_NEAR_KEY']) {
    if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  }
  const network = process.env.REIN_NETWORK;
  if (network !== 'testnet' && network !== 'mainnet') throw new Error('REIN_NETWORK must be testnet or mainnet');
  const deployment = DEPLOYMENTS[network];
  if (!deployment.desk) throw new Error('No desk configured for REIN_NETWORK');
  const rpcUrl = network === 'testnet' ? 'https://rpc.testnet.fastnear.com' : 'https://rpc.mainnet.fastnear.com';
  const reader = httpReader(process.env.REIN_API_URL ?? deployment.api, rpcUrl, deployment.desk);
  const payer = nearPayer({
    rpcUrl,
    desk: deployment.desk,
    account: process.env.REIN_NEAR_ACCOUNT!,
    key: process.env.REIN_NEAR_KEY!,
  });
  const server = toolServer(
    makeTools(reader, payer, {
      now: () => Date.now() / 1000,
      sleep(ms) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      },
    }),
  );
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'MCP startup failed';
  const key = process.env.REIN_NEAR_KEY;
  for (const secret of [key, key?.split(':').at(-1)]) if (secret) message = message.split(secret).join('[redacted]');
  console.error(message);
  process.exitCode = 1;
});
