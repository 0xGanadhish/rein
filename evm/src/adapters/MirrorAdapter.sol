// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";
import {MirrorVault} from "../MirrorVault.sol";

/// @notice Liquidity adapter for Tare's testnet MirrorVaults.
contract MirrorAdapter is ILiquidityAdapter {
    function availableLiquidity(address vault) external view returns (uint256) {
        return MirrorVault(vault).availableLiquidity();
    }
}
