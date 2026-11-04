import type { DeskChain } from '../../shared/desk';
import { NETWORK_CHAINS } from './deskTypes';
import type { NearNetwork } from './env';
import { MIN_GAS_WEI } from './order';

/** 0.2 NEAR on the agent account. */
export const MIN_AGENT_YOCTO = 2n * 10n ** 23n;
/** Flag the agent key once less than this share of its allowance is left. */
export const MIN_ALLOWANCE_PCT = 20;

export interface HealthDeps {
  derivedAddress(): Promise<string>;
  gasBalance(chain: DeskChain, address: string): Promise<bigint>;
  agent(): Promise<{ balance: bigint; allowance: bigint | null }>;
  /** What the agent key was granted, in yoctoNEAR; null if unknown. */
  allowanceGranted: bigint | null;
}

export interface Health {
  ok: boolean;
  flags: string[];
  /** wei per chain, as decimal strings; null where the read failed. */
  gas: Partial<Record<DeskChain, string | null>>;
  agent_yocto: string | null;
  /** Share of the agent key's allowance left; null when unlimited or unknown. */
  allowance_pct: number | null;
}

/**
 * Balances the desk needs to keep working: gas on the derived address on each chain (1 MON, 0.0001 ETH), 0.2 NEAR on
 * the agent account, and at least 20% of the agent key's function-call allowance. A read that fails is a flag too.
 */
export async function checkHealth(network: NearNetwork, deps: HealthDeps): Promise<Health> {
  const flags: string[] = [];
  const gas: Health['gas'] = {};
  let address: string | null = null;
  try {
    address = await deps.derivedAddress();
  } catch {
    flags.push('derived_address_unreadable');
  }
  if (address) {
    for (const chain of NETWORK_CHAINS[network]) {
      try {
        const wei = await deps.gasBalance(chain, address);
        gas[chain] = String(wei);
        if (wei < MIN_GAS_WEI[chain]) flags.push(`low_gas:${chain}`);
      } catch {
        gas[chain] = null;
        flags.push(`gas_unreadable:${chain}`);
      }
    }
  }

  let agentYocto: string | null = null;
  let allowancePct: number | null = null;
  try {
    const { balance, allowance } = await deps.agent();
    agentYocto = String(balance);
    if (balance < MIN_AGENT_YOCTO) flags.push('low_near');
    if (allowance !== null && deps.allowanceGranted) {
      allowancePct = Number((allowance * 10_000n) / deps.allowanceGranted) / 100;
      if (allowancePct < MIN_ALLOWANCE_PCT) flags.push('low_allowance');
    }
  } catch {
    flags.push('agent_unreadable');
  }
  return { ok: flags.length === 0, flags, gas, agent_yocto: agentYocto, allowance_pct: allowancePct };
}
