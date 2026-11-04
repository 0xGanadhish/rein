// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILiquidityAdapter} from "./interfaces/ILiquidityAdapter.sol";

/// @title TareRiskOracle
/// @notice Public, append-only record of Jev's verdicts on ERC-4626 vaults. Each post snapshots the vault's
/// share price, total assets and withdrawable liquidity so the verdict can later be graded from onchain data
/// alone. `stateHash` commits to the exact state document Jev was shown (archived publicly offchain).
contract TareRiskOracle {
    enum Verdict {
        HOLD,
        EXIT,
        MOVE
    }

    struct Post {
        address vault;
        Verdict verdict;
        uint16 confidenceBps;
        uint16 riskBps;
        bytes32 stateHash;
        uint64 postedAt;
        uint256 ppsAtPost;
        uint256 assetsAtPost;
        uint256 liquidityAtPost;
    }

    /// Worst values seen while sampling (spec §2b). `liquidityBps` is liquidity as bps of total assets, capped at 10,000.
    struct Sample {
        uint32 count;
        bool broken;
        uint16 liquidityBps;
        uint256 pps;
        uint256 assets;
    }

    struct Resolution {
        bool resolved;
        bool adverse;
        uint8 reasons;
        uint64 resolvedAt;
    }

    uint16 internal constant MAX_BPS = 10_000;
    /// Share price fell more than 0.5%.
    uint16 public constant PPS_DROP_BPS = 50;
    /// Total assets fell more than 20%.
    uint16 public constant TVL_DROP_BPS = 2_000;
    /// Withdrawable liquidity below 5% of total assets.
    uint16 public constant LIQ_FLOOR_BPS = 500;
    uint8 public constant REASON_PPS = 1;
    uint8 public constant REASON_TVL = 2;
    uint8 public constant REASON_LIQ = 4;
    /// The vault's (or adapter's) views reverted at grading time.
    uint8 public constant REASON_BROKEN = 8;
    /// After a failed metrics read, at least this much gas must remain, so a caller can't starve the read
    /// (63/64 rule) to fake a "broken" grade: leaving this much means the read itself had ~6.4M gas.
    uint256 internal constant BROKEN_GAS_GUARD = 100_000;

    address public immutable owner;
    uint64 public immutable resolveWindow;
    /// After `resolveWindow`, how long anyone may `sample`; `resolve` waits for it to close. Zero: grade on one read at resolve.
    uint64 public immutable sampleWindow;
    address public attester;
    uint256 public postCount;

    mapping(address vault => bool) public registered;
    mapping(address vault => address) public adapterOf;
    mapping(address vault => uint256) public latest;
    mapping(uint256 id => Post) internal _posts;
    mapping(uint256 id => Resolution) internal _resolutions;
    mapping(uint256 id => Sample) internal _samples;

    error NotOwner();
    error NotAttester();
    error VaultNotRegistered();
    error AdapterLocked();
    error BpsOutOfRange();
    error ZeroArg();
    error InsufficientGas();
    error UnknownPost();
    error WindowOpen();
    error AlreadyResolved();
    error SamplingOpen();
    error SamplingClosed();

    event VerdictPosted(
        uint256 indexed id,
        address indexed vault,
        Verdict verdict,
        uint16 confidenceBps,
        uint16 riskBps,
        bytes32 stateHash,
        uint64 postedAt
    );
    event VerdictResolved(uint256 indexed id, bool adverse, uint8 reasons);
    event VerdictSampled(uint256 indexed id, bool broken, uint256 pps, uint256 assets, uint16 liquidityBps);
    event VaultRegistered(address indexed vault, address adapter);
    event AttesterChanged(address attester);

    constructor(address owner_, address attester_, uint64 resolveWindow_, uint64 sampleWindow_) {
        if (owner_ == address(0) || attester_ == address(0) || resolveWindow_ == 0) revert ZeroArg();
        owner = owner_;
        attester = attester_;
        resolveWindow = resolveWindow_;
        sampleWindow = sampleWindow_;
        emit AttesterChanged(attester_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Register a vault for verdicts, with an optional liquidity adapter (zero = liquidity not graded).
    /// The adapter is fixed once the vault has a verdict, so past verdicts are always graded by the same rule.
    function registerVault(address vault, address adapter) external onlyOwner {
        if (latest[vault] != 0) revert AdapterLocked();
        registered[vault] = true;
        adapterOf[vault] = adapter;
        emit VaultRegistered(vault, adapter);
    }

    function setAttester(address attester_) external onlyOwner {
        attester = attester_;
        emit AttesterChanged(attester_);
    }

    function post(address vault, Verdict verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash)
        external
        returns (uint256 id)
    {
        if (msg.sender != attester) revert NotAttester();
        if (!registered[vault]) revert VaultNotRegistered();
        if (confidenceBps > MAX_BPS || riskBps > MAX_BPS) revert BpsOutOfRange();
        // A vault whose views revert still gets its verdict on record (snapshot zeros); grading marks it broken.
        (uint256 pps, uint256 assets, uint256 liquidity) = (0, 0, 0);
        try this.metricsOf(vault) returns (uint256 pps_, uint256 assets_, uint256 liquidity_) {
            (pps, assets, liquidity) = (pps_, assets_, liquidity_);
        } catch {}
        id = ++postCount;
        _posts[id] = Post({
            vault: vault,
            verdict: verdict,
            confidenceBps: confidenceBps,
            riskBps: riskBps,
            stateHash: stateHash,
            postedAt: uint64(block.timestamp),
            ppsAtPost: pps,
            assetsAtPost: assets,
            liquidityAtPost: liquidity
        });
        latest[vault] = id;
        emit VerdictPosted(id, vault, verdict, confidenceBps, riskBps, stateHash, uint64(block.timestamp));
    }

    /// @notice Record a reading of the vault while the post's sampling window is open. Anyone can call it.
    /// Only the worst values are kept, so a reading taken inside a flash loan can make a grade harsher, never kinder.
    function sample(uint256 id) external {
        Post storage p = _gradable(id);
        uint256 opens = uint256(p.postedAt) + resolveWindow;
        if (block.timestamp < opens) revert WindowOpen();
        if (block.timestamp >= opens + sampleWindow) revert SamplingClosed();
        _sample(id, p.vault);
    }

    /// @notice Grade a verdict once its windows have passed, from onchain data only. Anyone can call it.
    /// Adverse means the vault got worse for depositors: share price fell, assets fled, or liquidity dried up.
    /// It grades the worst sample; if nobody sampled, it takes one reading now.
    function resolve(uint256 id) external returns (bool adverse) {
        Post storage p = _gradable(id);
        uint256 opens = uint256(p.postedAt) + resolveWindow;
        if (block.timestamp < opens) revert WindowOpen();
        if (block.timestamp < opens + sampleWindow) revert SamplingOpen();

        Sample storage s = _samples[id];
        if (s.count == 0 && !s.broken) _sample(id, p.vault);

        uint8 reasons = s.broken ? REASON_BROKEN : 0;
        if (s.count != 0) {
            if (s.pps * MAX_BPS < p.ppsAtPost * (MAX_BPS - PPS_DROP_BPS)) reasons |= REASON_PPS;
            if (s.assets * MAX_BPS < p.assetsAtPost * (MAX_BPS - TVL_DROP_BPS)) reasons |= REASON_TVL;
            if (adapterOf[p.vault] != address(0) && s.liquidityBps < LIQ_FLOOR_BPS) reasons |= REASON_LIQ;
        }

        adverse = reasons != 0;
        _resolutions[id] =
            Resolution({resolved: true, adverse: adverse, reasons: reasons, resolvedAt: uint64(block.timestamp)});
        emit VerdictResolved(id, adverse, reasons);
    }

    function _gradable(uint256 id) internal view returns (Post storage) {
        if (id == 0 || id > postCount) revert UnknownPost();
        if (_resolutions[id].resolved) revert AlreadyResolved();
        return _posts[id];
    }

    /// @dev One reading, folded into the worst values so far. A reverting read marks the sample broken for good.
    function _sample(uint256 id, address vault) internal {
        Sample storage s = _samples[id];
        try this.metricsOf(vault) returns (uint256 pps, uint256 assets, uint256 liquidity) {
            uint16 liqBps = _liquidityBps(liquidity, assets);
            if (s.count == 0) {
                (s.pps, s.assets, s.liquidityBps) = (pps, assets, liqBps);
            } else {
                if (pps < s.pps) s.pps = pps;
                if (assets < s.assets) s.assets = assets;
                if (liqBps < s.liquidityBps) s.liquidityBps = liqBps;
            }
            s.count++;
            emit VerdictSampled(id, false, pps, assets, liqBps);
        } catch {
            if (gasleft() < BROKEN_GAS_GUARD) revert InsufficientGas();
            s.broken = true;
            emit VerdictSampled(id, true, 0, 0, 0);
        }
    }

    /// @dev Liquidity as bps of total assets, capped at 10,000 (also for "no adapter" and an empty vault).
    function _liquidityBps(uint256 liquidity, uint256 assets) internal pure returns (uint16) {
        if (liquidity >= assets) return MAX_BPS;
        return uint16(Math.mulDiv(liquidity, MAX_BPS, assets));
    }

    function getSample(uint256 id) external view returns (Sample memory) {
        return _samples[id];
    }

    function getPost(uint256 id) external view returns (Post memory) {
        return _posts[id];
    }

    function getResolution(uint256 id) external view returns (Resolution memory) {
        return _resolutions[id];
    }

    /// @notice Current share price (assets per whole share), total assets and withdrawable liquidity
    /// (`type(uint256).max` when the vault has no adapter). Reverts if the vault or adapter does.
    function metricsOf(address vault) external view returns (uint256 pps, uint256 assets, uint256 liquidity) {
        IERC4626 v = IERC4626(vault);
        pps = v.convertToAssets(10 ** v.decimals());
        assets = v.totalAssets();
        address adapter = adapterOf[vault];
        liquidity = adapter == address(0) ? type(uint256).max : ILiquidityAdapter(adapter).availableLiquidity(vault);
    }
}
