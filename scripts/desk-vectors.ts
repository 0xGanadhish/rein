/**
 * Writes near/desk/tests/vectors.json: oracle posts encoded and signed by viem, which the desk's
 * hand-written calldata, RLP and signing code is tested against.
 *
 *   node --experimental-strip-types scripts/desk-vectors.ts
 */
import { writeFileSync } from 'node:fs';
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseGwei,
  serializeTransaction,
  toHex,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { sign } from 'viem/accounts';

const abi = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil)',
]);
const CHAIN_IDS = { 'monad-testnet': 10143, monad: 143, base: 8453, 'base-sepolia': 84532 } as const;
const VERDICTS = { HOLD: 0, EXIT: 1, MOVE: 2 } as const;
/** A throwaway key; only its signatures are used. */
const KEY: Hex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

interface Case {
  chain: keyof typeof CHAIN_IDS;
  verdict: keyof typeof VERDICTS;
  nonce: bigint;
  max_priority_fee_per_gas: bigint;
  max_fee_per_gas: bigint;
  gas: bigint;
  oracle: Hex;
  vault: Hex;
  confidence_bps: number;
  risk_bps: number;
  doc: string;
  valid_until: bigint;
}

const ORACLE: Hex = '0x00000000000000000000000000000000000000a1';
const cases: Case[] = [
  {
    chain: 'monad-testnet',
    verdict: 'HOLD',
    nonce: 0n,
    max_priority_fee_per_gas: parseGwei('2'),
    max_fee_per_gas: parseGwei('102'),
    gas: 200_000n,
    oracle: ORACLE,
    vault: '0x1111111111111111111111111111111111111111',
    confidence_bps: 8100,
    risk_bps: 1200,
    doc: 'a',
    valid_until: 1_793_774_400n,
  },
  {
    chain: 'monad',
    verdict: 'EXIT',
    nonce: 1n << 40n,
    max_priority_fee_per_gas: 0n,
    max_fee_per_gas: parseGwei('500'),
    gas: 200_000n,
    oracle: '0x9e3b1f2a5d4c6b7a8e9f0a1b2c3d4e5f6a7b8c9d',
    vault: '0x00000000000000000000000000000000000000ff',
    confidence_bps: 10_000,
    risk_bps: 10_000,
    doc: 'b',
    valid_until: (1n << 64n) - 1n,
  },
  {
    chain: 'base',
    verdict: 'MOVE',
    nonce: 0n,
    max_priority_fee_per_gas: 1_000_000n,
    max_fee_per_gas: 12_345_678n,
    gas: 150_000n,
    oracle: '0xffffffffffffffffffffffffffffffffffffffff',
    vault: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    confidence_bps: 0,
    risk_bps: 0,
    doc: 'c',
    valid_until: 0n,
  },
  {
    chain: 'base',
    verdict: 'HOLD',
    nonce: 1n << 40n,
    max_priority_fee_per_gas: 1n,
    max_fee_per_gas: 127n,
    gas: 21_000n,
    oracle: ORACLE,
    vault: '0x2222222222222222222222222222222222222222',
    confidence_bps: 1,
    risk_bps: 9999,
    doc: 'd',
    valid_until: 1n,
  },
  {
    chain: 'monad-testnet',
    verdict: 'EXIT',
    nonce: 1n << 40n,
    max_priority_fee_per_gas: 128n,
    max_fee_per_gas: (1n << 64n) + 5n,
    gas: 1_000_000n,
    oracle: ORACLE,
    vault: '0x3333333333333333333333333333333333333333',
    confidence_bps: 5000,
    risk_bps: 6400,
    doc: 'e',
    valid_until: 255n,
  },
  {
    chain: 'monad',
    verdict: 'MOVE',
    nonce: 0n,
    max_priority_fee_per_gas: parseGwei('1'),
    max_fee_per_gas: parseGwei('200'),
    gas: 300_000n,
    oracle: ORACLE,
    vault: '0x4444444444444444444444444444444444444444',
    confidence_bps: 7300,
    risk_bps: 128,
    doc: 'f',
    valid_until: 4_294_967_295n,
  },
  {
    chain: 'base-sepolia',
    verdict: 'HOLD',
    nonce: 0n,
    max_priority_fee_per_gas: 1_000_000n,
    max_fee_per_gas: 12_345_678n,
    gas: 400_000n,
    oracle: ORACLE,
    vault: '0x5555555555555555555555555555555555555555',
    confidence_bps: 8100,
    risk_bps: 1200,
    doc: 'g',
    valid_until: 1_793_774_400n,
  },
];

const out = [];
for (const c of cases) {
  const state_hash = keccak256(toHex(`rein-v1|${c.doc}`));
  const data = encodeFunctionData({
    abi,
    functionName: 'post',
    args: [c.vault, VERDICTS[c.verdict], c.confidence_bps, c.risk_bps, state_hash, c.valid_until],
  });
  const tx: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: CHAIN_IDS[c.chain],
    nonce: Number(c.nonce),
    maxPriorityFeePerGas: c.max_priority_fee_per_gas,
    maxFeePerGas: c.max_fee_per_gas,
    gas: c.gas,
    to: c.oracle,
    value: 0n,
    data,
  };
  const unsigned = serializeTransaction(tx);
  const payload_hash = keccak256(unsigned);
  const sig = await sign({ hash: payload_hash, privateKey: KEY });
  const yParity = sig.yParity ?? 0;
  out.push({
    chain: c.chain,
    chain_id: CHAIN_IDS[c.chain],
    verdict: VERDICTS[c.verdict],
    nonce: c.nonce.toString(),
    max_priority_fee_per_gas: c.max_priority_fee_per_gas.toString(),
    max_fee_per_gas: c.max_fee_per_gas.toString(),
    gas: c.gas.toString(),
    oracle: c.oracle,
    vault: c.vault,
    confidence_bps: c.confidence_bps,
    risk_bps: c.risk_bps,
    state_hash,
    valid_until: c.valid_until.toString(),
    calldata: data,
    unsigned,
    payload_hash,
    /** r || s || yParity, 65 bytes. */
    signature: `${sig.r}${sig.s.slice(2)}${yParity.toString(16).padStart(2, '0')}`,
    signed: serializeTransaction(tx, { r: sig.r, s: sig.s, yParity }),
  });
}

const path = new URL('../near/desk/tests/vectors.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.length} cases to ${path.pathname}`);
