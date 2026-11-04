// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ILiquidityAdapter} from "../interfaces/ILiquidityAdapter.sol";

/// @dev Minimal slice of the Euler Vault Kit (EVK) EVault interface.
interface IEVaultCash {
    function cash() external view returns (uint256);
}

/// @notice Liquidity adapter for Euler EVK vaults: idle cash held by the vault is what can be withdrawn.
contract EulerAdapter is ILiquidityAdapter {
    function availableLiquidity(address vault) external view returns (uint256) {
        return IEVaultCash(vault).cash();
    }
}
