// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockToken} from "./MockToken.sol";

/// @notice ERC-4626 vault mirroring a real vault's APY and utilization. Interest is real:
/// it is minted (MockToken) into the vault; withdrawals are capped by (1 - utilization).
contract MirrorVault is ERC4626 {
    error NotAdmin();

    event StatsUpdated(uint16 apyBps, uint16 utilizationBps, uint256 timestamp);

    string public mirrorOf;
    uint16 public apyBps;
    uint16 public utilizationBps;
    address public admin;
    uint256 public lastAccrual;

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        string memory mirrorOf_,
        uint16 apyBps_,
        uint16 utilizationBps_,
        address admin_
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        mirrorOf = mirrorOf_;
        apyBps = apyBps_;
        utilizationBps = utilizationBps_;
        admin = admin_;
        lastAccrual = block.timestamp;
    }

    function setStats(uint16 apyBps_, uint16 utilizationBps_) external {
        if (msg.sender != admin) revert NotAdmin();
        _accrue();
        apyBps = apyBps_;
        utilizationBps = utilizationBps_;
        emit StatsUpdated(apyBps_, utilizationBps_, block.timestamp);
    }

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + _pendingInterest();
    }

    function availableLiquidity() public view returns (uint256) {
        return totalAssets() * (10_000 - utilizationBps) / 10_000;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), availableLiquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), convertToShares(availableLiquidity()));
    }

    function _pendingInterest() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0 || apyBps == 0) return 0;
        return IERC20(asset()).balanceOf(address(this)) * apyBps * elapsed / (365 days * 10_000);
    }

    function _accrue() internal {
        uint256 interest = _pendingInterest();
        lastAccrual = block.timestamp;
        if (interest > 0) MockToken(asset()).mint(address(this), interest);
    }

    // _deposit / _withdraw back deposit, mint, withdraw and redeem. Accruing here is value-neutral
    // for the share maths already done by the caller because totalAssets() includes pending interest.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        _accrue();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _accrue();
        super._withdraw(caller, receiver, owner_, assets, shares);
    }
}
