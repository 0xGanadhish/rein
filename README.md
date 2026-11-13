# Rein

Rein is a risk desk for agents, and it runs on a NEAR contract. An agent that manages stablecoins pays it to judge a yield vault, through one MCP tool call or an x402 payment over HTTP. A model inside a NEAR AI Cloud TEE reads the vault's onchain state and answers HOLD, EXIT or MOVE. The contract checks the model's signature, then NEAR Chain Signatures signs a transaction that posts the verdict to an oracle on Monad or Base. Every verdict is graded later on a public Ledger. A person can buy the same verdict in the browser.

- Site: <https://www.reinfi.xyz/?network=testnet>
- Testnet API: <https://api-testnet.reinfi.xyz>
- Agent tools (MCP, streamable HTTP): `https://api-testnet.reinfi.xyz/mcp`
- For agents: <https://www.reinfi.xyz/llms.txt>
- Guardian from code: the MCP tool `guardian_transactions` returns unsigned transactions to deposit into a vault and arm or disarm Guardian on Base or Monad; your wallet signs them.
- Built for NEAR HACKATHON, November 2026. Licence: MIT.

A verdict is advice. It is not a guarantee and it does not protect a position by itself.

## The problem

An agent that holds stablecoins in yield vaults cannot tell when a vault is turning risky, and neither can the person it works for. A model can give an opinion, but then the buyer has to trust whoever runs the model. The operator could change the answer, post it for a different vault, replay an old EXIT later, or take the payment and deliver nothing.

Rein is built so the operator cannot do those things. The Worker that runs the desk day to day holds a key that can only call eight methods on the contract. It cannot sign an EVM transaction, choose where a post goes, or move a customer's payment.

## What NEAR does

| NEAR piece | What Rein uses it for |
| --- | --- |
| Contract `rein-desk` | Takes payment in NEAR or USDC, holds it in escrow, and pays a 70/30 treasury/agent split only when delivery is reported. It refunds in full if the post fails or the deadline passes. |
| NEAR AI Cloud (TEE) | Runs `Qwen/Qwen3.6-35B-A3B-FP8` and signs each answer. The contract rebuilds the exact request from its own stored prompt, recovers the signer, and refuses anything not signed by an owner-approved TEE key. |
| Chain Signatures (MPC) | Signs the EVM transaction. The contract builds the calldata itself from the verified answer, so the oracle address, vault, verdict and expiry are not the agent's to choose. The oracle accepts posts only from the contract's derived address. |
| NEAR Intents, through PingPay x402 | Lets an agent on another chain pay in USDC without a NEAR account. Mainnet only. |

## Try it

Steps 1 to 5 need no wallet, no key and no funds.

1. **Open a delivered order.** Go to <https://www.reinfi.xyz/orders/20?network=testnet>. See a HOLD verdict and a "Verify this order" section that links the NEAR order, the exact document the model read, the TEE signer, and the Monad testnet transaction.
2. **Read the Ledger.** Run `curl https://api-testnet.reinfi.xyz/v1/ledger`. See `posts`, the `score` object with `n` and `brier`, and `recent` rows with `resolved`, `adverse` and `signer`. The same data is at <https://www.reinfi.xyz/ledger?network=testnet>.
3. **List the agent tools.** Run:

   ```sh
   curl -s -X POST https://api-testnet.reinfi.xyz/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   See five tools: `list_vaults`, `latest_verdict`, `get_verdict`, `order_status` and `ledger`.
4. **Verify a real TEE signature offline.** Clone the repository, then from `near/` run `cargo test -p desk --lib real_fixture_verifies`. See `1 passed`. The test feeds a recorded NEAR AI request, response and signature from `near/desk/tests/fixtures/near-ai-1.json` through the contract's own verification code, with no network.
5. **Compare Rein with simple forecasts.** From the repository root run `pnpm install`, then `pnpm baseline --check`. See `--check PASS` and a four-row table. Then run `pnpm baseline https://api-testnet.reinfi.xyz/v1/ledger` to score the live testnet Ledger the same way. This needs Node 22.6 or newer.
6. **Buy a verdict with an agent.** Follow [docs/buy-with-an-agent.md](docs/buy-with-an-agent.md). You need a NEAR testnet account with about 0.2 NEAR. An MCP client such as Claude Code calls `get_verdict`, pays 0.1 NEAR, and gets the verdict and its proof links back in one tool call. Order 20 above was bought this way and took 49 seconds.
7. **Buy one in the browser.** Open <https://www.reinfi.xyz/judge?network=testnet>, connect a NEAR testnet wallet, pick a vault and pay. See the order move from open to delivered, then open its receipt.

## Follow the proof for one order

Order 20 on testnet, bought by the agent account `agent-rein.testnet`:

| Stage | What to check | Where |
| --- | --- | --- |
| Payment and order | 0.1 NEAR from `agent-rein.testnet`, status `delivered` | `curl https://api-testnet.reinfi.xyz/v1/orders/20` |
| Document | The `doc` string the model read. Its keccak256 is the posted `state_hash`, `0x561e…ef1d` | Same response, `posts[0].doc` and `posts[0].state_hash` |
| Model signature | Signing address `0x3b753b4406613c5e70ae640508632b600424fa0c`, the TEE key in `attestations/` | Same response, `judge_calls[0].signing_address` |
| EVM post | Sent to oracle `0x16b998475d3c2b7FB5b794406701167039fD841A` by the desk's derived address, `0xfe48d719c50092cda5e6c7be54e91fe1acc39985` | [Monad testnet transaction](https://testnet.monadscan.com/tx/0x0ee3d834cbd160619ad0cf19c39f436c4b5e029dc0dd91720c709e76b8138510) |
| Grade | `resolved: true`, `adverse: false` one hour later | `curl https://api-testnet.reinfi.xyz/v1/ledger`, the row with `order_id: 20` |

## Attacks the contracts refuse

Each of these was run against the live testnet deployment. The output is committed.

| Attack | Result | Log |
| --- | --- | --- |
| Change one character of the model's answer | `unknown signer` | [docs/tamper.log](docs/tamper.log) |
| Sign the answer with a different key | `unknown signer` | [docs/tamper.log](docs/tamper.log) |
| Replay a real signed reading on another order | `wrong order` | [docs/tamper.log](docs/tamper.log) |
| Corrupt the signature's recovery byte | `bad signature` | [docs/tamper.log](docs/tamper.log) |
| Post the same verdict to the oracle twice | `StateAlreadyPosted` | [docs/replay.log](docs/replay.log) |
| Post a held verdict after its expiry | `PostExpired` | [docs/replay.log](docs/replay.log) |
| Open 140 orders on one vault in 16.5 seconds from 20 keys | 1 order opened, 139 refused | [docs/burst-replay.log](docs/burst-replay.log) |

## What is live

As of 12 November 2026.

| Part | Status |
| --- | --- |
| Testnet desk `rein-desk.testnet`, posting to Monad testnet and Base Sepolia | Live. 21 orders opened, 19 delivered, 2 rejected and refunded |
| Site, public API and remote MCP free tools | Live on testnet |
| Agent purchase through local MCP | Done on testnet (order 20) |
| Grading | Live on testnet. 19 posts, 7 scored calls |
| Mainnet desk `rein-desk.near` and the Monad and Base oracles | Not deployed yet |
| x402 purchases | Code merged. Mainnet only, so no live purchase yet |
| Guardian automatic exits | Code merged and switched off. No live exit yet |
| MOVE quote and cross-chain top-up | Code merged. Not tried live |
| EXIT push alerts | Code merged and switched off |

Testnet addresses:

| Chain | Rein oracle | Example menu vault (rmSTEAK mirror) |
| --- | --- | --- |
| Monad testnet | `0x16b998475d3c2b7FB5b794406701167039fD841A` | `0xA32cF682DA4A62c056fD631eE91dfE3C713EF1DB` |
| Base Sepolia | `0xd535a4068265b383976d92718e3E650b5183b6Ab` | `0x7B1D9003983c0B55B8b15aA37e7E188Ce6AabdC8` |

All deployed addresses are in [shared/deployments.ts](shared/deployments.ts). The testnet vaults are Rein's own mirror vaults on mock USDC.

## How good the verdicts are

The Ledger scores each verdict's risk forecast against what happened to the vault afterwards, using the Brier score, where lower is better. On the live testnet Ledger on 12 November:

| Forecast | Calls scored | Brier |
| --- | ---: | ---: |
| Rein | 7 | 0.116 |
| Fixed rule: EXIT if utilization is at least 95% or liquidity is under 2% | 7 | 0.124 |
| Base rate, known only in hindsight | 7 | 0.204 |
| Coin flip | 7 | 0.250 |

Seven calls on mirror vaults is far too few to show the model beats a fixed rule. The table is here so anyone can rerun it as the sample grows.

## Trust limits

- A TEE signature proves which model produced an answer from which document. It does not prove the document's inputs were true. The Worker reads vault state over RPC and the contract cannot check it.
- The owner approves the model signers and the prompt, and the oracle trusts one attester address. Those are trust boundaries.
- The contract trusts the agent's delivery and failure reports and the gas fee it reports. It does not verify EVM receipt proofs.
- If a post lands but the Worker stays down past the post's expiry plus a grace period, a customer could get both the post and a refund.
- Confidence is not calibrated accuracy. The Ledger scores the risk forecast, not the confidence.
- "Adverse" is measured from asset decline and outflows. It is a proxy, not proof that a depositor lost money.
- x402 payments settle before the judgement and are not escrowed. If the judgement fails, the buyer gets one replacement judgement, not money back.
- Guardian exits need the owner to opt in, a fresh verdict, enough vault liquidity and a funded executor. A partial exit can leave funds in the vault.

## Tests

Run on 12 November 2026:

| Suite | Command | Result |
| --- | --- | --- |
| Desk contract, unit | `cargo test -p desk --lib` from `near/` | 37 passed |
| Worker | `pnpm -C worker test` | 103 passed |
| Web | `pnpm -C web test` | 34 passed |
| MCP server | `pnpm -C mcp test` | 4 passed |
| Oracle, Guardian and adapters | `forge test` from `evm/` | 14 passed, 2 skipped because they need a Base fork |
| Baseline self-check | `pnpm baseline --check` | Pass |

Three more suites need extra setup and were not rerun on that date: the desk's 63 sandbox tests (they need the three wasm builds), the Base fork tests, and the browser tests. [docs/reference.md](docs/reference.md#local-verification) has their commands.

## Built with

- **NEAR:** Rust and `near-sdk` for the desk contract; `@near-js/accounts`, `crypto`, `providers` and `signers` in the Worker and MCP server.
- **EVM:** Solidity and Foundry, with OpenZeppelin contracts and `forge-std` vendored in `evm/lib`.
- **Worker:** TypeScript and Hono on Cloudflare Workers, with D1.
- **Web:** Next.js and React.
- **Shared:** `viem` for EVM encoding and hashing, `@modelcontextprotocol/sdk` for the MCP server, Vitest and Playwright for tests.

Exact versions are pinned in the lockfiles.

**Reused code.** The first commit vendors the risk oracle, the vault adapters and the grading code from [Tare](https://github.com/0xGanadhish/tare) at `b584c863`, under MIT. Tare is my earlier project on Monad and was written before this hackathon. Everything after that commit is hackathon work, including the NEAR contract, the Worker, the MCP server, the site, and the oracle's replay and expiry checks.

## More detail

- [docs/reference.md](docs/reference.md): order states, refunds, Worker recovery, the Ledger and health fields, the API and the x402 flow.
- [docs/buy-with-an-agent.md](docs/buy-with-an-agent.md): the agent buyer walkthrough.
- [docs/vaults.md](docs/vaults.md): which Base vaults Rein can grade, and why.
- [CONTRIBUTING.md](CONTRIBUTING.md): branches and code quality commands.
