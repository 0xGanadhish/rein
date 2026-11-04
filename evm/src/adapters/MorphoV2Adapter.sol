// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";

/// @dev Minimal slice of the Morpho Vault V2 interface.
interface IMorphoVaultV2 {
    function asset() external view returns (address);
    function liquidityAdapter() external view returns (address);
    function liquidityData() external view returns (bytes memory);
}

/// @dev Morpho Vault V2 adapter that supplies to a Morpho Blue market.
interface IMorphoMarketAdapter {
    function morpho() external view returns (address);
}

/// @dev Minimal slice of Morpho Blue.
interface IMorphoBlue {
    function market(bytes32 id)
        external
        view
        returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128, uint128, uint128);
    function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128, uint128);
}

/// @notice Liquidity adapter for Morpho Vault V2: idle assets plus what a withdrawal can pull from the vault's
/// liquidity market. V2 only deallocates from `liquidityAdapter()` (with `liquidityData()`) on withdraw; other
/// allocations need curator action, so they are not instant liquidity.
/// The allocator can switch the liquidity adapter at any time and the oracle locks this adapter at a vault's first
/// verdict, so a liquidity market this contract can't read counts as 0 (idle only) instead of reverting every read.
/// DeployV2 rejects such a vault up front (AdapterKinds.check). Morpho's market totals exclude interest not yet
/// accrued, which only makes the market share slightly low.
contract MorphoV2Adapter is ILiquidityAdapter {
    function availableLiquidity(address vault) external view returns (uint256 liquidity) {
        IMorphoVaultV2 v = IMorphoVaultV2(vault);
        liquidity = IERC20(v.asset()).balanceOf(vault);
        address liqAdapter = v.liquidityAdapter();
        if (liqAdapter == address(0)) return liquidity;
        liquidity += _marketLiquidity(liqAdapter, keccak256(v.liquidityData()));
    }

    /// @dev What the liquidity market can pay `liqAdapter` now: its supply, capped by the market's cash. Every call
    /// is low-level with a length check, so an EOA or a contract of another shape reads as 0.
    function _marketLiquidity(address liqAdapter, bytes32 id) internal view returns (uint256) {
        (bool ok, bytes memory ret) = liqAdapter.staticcall(abi.encodeCall(IMorphoMarketAdapter.morpho, ()));
        if (!ok || ret.length != 32) return 0;
        uint256 raw = abi.decode(ret, (uint256));
        if (raw > type(uint160).max) return 0;
        address morpho = address(uint160(raw));

        (ok, ret) = morpho.staticcall(abi.encodeCall(IMorphoBlue.market, (id)));
        if (!ok || ret.length != 192) return 0;
        (uint256 supplyAssets, uint256 supplyShares, uint256 borrowAssets,,,) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256));
        if (supplyShares == 0 || borrowAssets >= supplyAssets) return 0;

        (ok, ret) = morpho.staticcall(abi.encodeCall(IMorphoBlue.position, (id, liqAdapter)));
        if (!ok || ret.length != 96) return 0;
        (uint256 shares,,) = abi.decode(ret, (uint256, uint256, uint256));
        return Math.min(Math.mulDiv(shares, supplyAssets, supplyShares), supplyAssets - borrowAssets);
    }
}
