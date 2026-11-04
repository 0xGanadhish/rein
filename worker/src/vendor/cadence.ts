import type { Network } from '../../shared/networks';

/** Workers Free allows 100k Durable Object requests a day; 4 testnet vaults at 5 s used ~69k of that on alarms alone. */
export const ALARM_MS: Record<Network, number> = { testnet: 15_000, mainnet: 30_000 };

/** TareRiskOracle.resolveWindow per network (immutable constructor argument, spec §4.1). */
export const RESOLVE_WINDOW_S: Record<Network, number> = { testnet: 3_600, mainnet: 86_400 };
/**
 * TareRiskOracle.sampleWindow per network (spec §2b). Mainnet grades on the worst reading in the hour after the
 * resolve window; testnet keeps the original oracle, which reads once at resolve time.
 */
export const SAMPLE_WINDOW_S: Record<Network, number> = { testnet: 0, mainnet: 3_600 };
