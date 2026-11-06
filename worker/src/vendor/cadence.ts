import type { DeskChain } from '../../../shared/desk';

/** TareRiskOracle.resolveWindow on each chain (immutable constructor argument, set in evm/script/DeployRein.s.sol). */
export const RESOLVE_WINDOW_S: Record<DeskChain, number> = { 'monad-testnet': 3_600, monad: 86_400, base: 86_400, 'base-sepolia': 3_600 };
/**
 * TareRiskOracle.sampleWindow on each chain. Mainnets grade on the worst reading in the hour after the resolve
 * window; the testnet demo feed reads once at resolve time.
 */
export const SAMPLE_WINDOW_S: Record<DeskChain, number> = { 'monad-testnet': 0, monad: 3_600, base: 3_600, 'base-sepolia': 0 };
