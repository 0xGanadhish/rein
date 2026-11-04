// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TareRiskOracle} from "./TareRiskOracle.sol";

/// @title GuardianV2
/// @notice Keeperless auto-exit. Anyone may call `exit`; it succeeds only when the oracle's latest verdict on
/// the vault is a fresh EXIT that meets the owner's own confidence rule and was posted after they opted in.
/// Assets always go to the position owner; Guardian never holds funds. The admin can only approve vaults.
contract GuardianV2 {
    struct Rule {
        bool enabled;
        uint16 minConfidenceBps;
        uint32 maxAge;
        uint64 enabledAt;
    }

    uint16 public constant MIN_CONFIDENCE_BPS = 8_000;
    uint16 public constant MAX_CONFIDENCE_BPS = 9_900;
    uint32 public constant MIN_MAX_AGE = 60;
    uint32 public constant MAX_MAX_AGE = 3_600;

    address public immutable admin;
    TareRiskOracle public immutable oracle;

    mapping(address vault => bool) public approvedVault;
    mapping(address owner => mapping(address vault => Rule)) public rules;
    /// Verdict ids at or below this can't exit the owner: set to the oracle's last id on enable (so a verdict
    /// from earlier in the same second doesn't count) and to the verdict's id after a full exit (so one verdict
    /// can't be replayed against a re-deposit). Partial exits keep it, so they can finish on the same verdict.
    mapping(address owner => mapping(address vault => uint256)) public verdictFloor;

    error NotAdmin();
    error VaultNotApproved();
    error RuleOutOfRange();
    error NotEnabled();
    error NoVerdict();
    error NotExitVerdict();
    error BelowThreshold();
    error StaleVerdict();
    error VerdictPredatesEnable();
    error NothingToExit();
    error VerdictAlreadyUsed();
    error ZeroArg();

    event Enabled(address indexed owner, address indexed vault, uint16 minConfidenceBps, uint32 maxAge);
    event Disabled(address indexed owner, address indexed vault);
    event Exited(
        address indexed owner,
        address indexed vault,
        uint256 indexed verdictId,
        address caller,
        uint256 shares,
        uint256 assets,
        uint256 remainingShares
    );
    event VaultApproved(address indexed vault, bool ok);

    constructor(address admin_, TareRiskOracle oracle_) {
        if (admin_ == address(0) || address(oracle_) == address(0)) revert ZeroArg();
        admin = admin_;
        oracle = oracle_;
    }

    function setVaultApproved(address vault, bool ok) external {
        if (msg.sender != admin) revert NotAdmin();
        approvedVault[vault] = ok;
        emit VaultApproved(vault, ok);
    }

    /// @notice Opt in (or update the rule). Resets `enabledAt`, so only verdicts posted from now on count.
    function enable(address vault, uint16 minConfidenceBps, uint32 maxAge) external {
        if (minConfidenceBps < MIN_CONFIDENCE_BPS || minConfidenceBps > MAX_CONFIDENCE_BPS) revert RuleOutOfRange();
        if (maxAge < MIN_MAX_AGE || maxAge > MAX_MAX_AGE) revert RuleOutOfRange();
        if (!approvedVault[vault]) revert VaultNotApproved();
        rules[msg.sender][vault] = Rule({
            enabled: true, minConfidenceBps: minConfidenceBps, maxAge: maxAge, enabledAt: uint64(block.timestamp)
        });
        verdictFloor[msg.sender][vault] = oracle.postCount();
        emit Enabled(msg.sender, vault, minConfidenceBps, maxAge);
    }

    function disable(address vault) external {
        if (!rules[msg.sender][vault].enabled) return;
        rules[msg.sender][vault].enabled = false;
        emit Disabled(msg.sender, vault);
    }

    /// @notice Redeem `owner`'s shares back to `owner` when the rule's conditions hold. Callable by anyone.
    /// @dev Tries the full position first, because real vaults under-report maxRedeem (Morpho Vault V2
    /// always returns 0; Euler Earn returns one share short). Falls back to maxRedeem for a partial exit.
    function exit(address vault, address owner) external returns (uint256 assets) {
        uint256 id = _checkVerdict(vault, owner);

        uint256 shares = IERC20(vault).balanceOf(owner);
        uint256 a = IERC20(vault).allowance(owner, address(this));
        if (a < shares) shares = a;
        if (shares == 0) revert NothingToExit();

        try IERC4626(vault).redeem(shares, owner, owner) returns (uint256 got) {
            assets = got;
        } catch {
            uint256 m = IERC4626(vault).maxRedeem(owner);
            if (m < shares) shares = m;
            if (shares == 0) revert NothingToExit();
            assets = IERC4626(vault).redeem(shares, owner, owner);
        }
        uint256 remaining = IERC20(vault).balanceOf(owner);
        if (remaining == 0) verdictFloor[owner][vault] = id;
        emit Exited(owner, vault, id, msg.sender, shares, assets, remaining);
    }

    /// @dev The six exit conditions (spec 4.3), in order, plus the verdict-floor check. Returns the verdict id that authorises the exit.
    function _checkVerdict(address vault, address owner) internal view returns (uint256 id) {
        if (!approvedVault[vault]) revert VaultNotApproved();
        Rule memory rule = rules[owner][vault];
        if (!rule.enabled) revert NotEnabled();
        id = oracle.latest(vault);
        if (id == 0) revert NoVerdict();
        TareRiskOracle.Post memory p = oracle.getPost(id);
        if (p.verdict != TareRiskOracle.Verdict.EXIT) revert NotExitVerdict();
        if (p.confidenceBps < rule.minConfidenceBps) revert BelowThreshold();
        if (block.timestamp - p.postedAt > rule.maxAge) revert StaleVerdict();
        if (p.postedAt < rule.enabledAt) revert VerdictPredatesEnable();
        if (id <= verdictFloor[owner][vault]) revert VerdictAlreadyUsed();
    }
}
