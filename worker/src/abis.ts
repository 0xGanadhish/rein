import { parseAbi } from 'viem';

/** The calls the Worker makes on TareRiskOracle (evm/src/TareRiskOracle.sol). */
export const oracleAbi = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256)',
  'error NotAttester()',
  'error VaultNotRegistered()',
  'error BpsOutOfRange()',
  'error InsufficientGas()',
  'error StateAlreadyPosted()',
  'error PostExpired()',
  'function sample(uint256 id)',
  'function resolve(uint256 id) returns (bool adverse)',
  'function postCount() view returns (uint256)',
  'function latest(address vault) view returns (uint256)',
  'function statePosted(bytes32 stateHash) view returns (bool)',
  'function getPost(uint256 id) view returns ((address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 postedAt, uint256 ppsAtPost, uint256 assetsAtPost, uint256 liquidityAtPost))',
  'function getResolution(uint256 id) view returns ((bool resolved, bool adverse, uint8 reasons, uint64 resolvedAt))',
  'function metricsOf(address vault) view returns (uint256 pps, uint256 assets, uint256 liquidity)',
  'event VerdictResolved(uint256 indexed id, bool adverse, uint8 reasons)',
]);

export const erc4626Abi = parseAbi([
  'function name() view returns (string)',
  'function totalAssets() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

export const mirrorVaultAbi = parseAbi([
  'function availableLiquidity() view returns (uint256)',
  'function apyBps() view returns (uint16)',
  'function utilizationBps() view returns (uint16)',
]);

export const liquidityAdapterAbi = parseAbi(['function availableLiquidity(address vault) view returns (uint256)']);

export const guardianAbi = parseAbi([
  'function exit(address vault, address owner) returns (uint256 assets)',
  'function oracle() view returns (address)',
  'function MIN_EXIT_GAS() view returns (uint256)',
  'function rules(address owner, address vault) view returns (bool enabled, uint16 minConfidenceBps, uint32 maxAge, uint64 enabledAt)',
  'function verdictFloor(address owner, address vault) view returns (uint256)',
  'event Enabled(address indexed owner, address indexed vault, uint16 minConfidenceBps, uint32 maxAge)',
  'event Exited(address indexed owner, address indexed vault, uint256 indexed verdictId, address caller, uint256 shares, uint256 assets, uint256 remainingShares)',
  'error VaultNotApproved()',
  'error NotEnabled()',
  'error NoVerdict()',
  'error NotExitVerdict()',
  'error BelowThreshold()',
  'error StaleVerdict()',
  'error VerdictPredatesEnable()',
  'error NothingToExit()',
  'error VerdictAlreadyUsed()',
  'error GasTooLow()',
]);
