// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Reports how much of a vault's underlying asset can be withdrawn right now.
/// TareRiskOracle uses it to grade the liquidity condition of a verdict.
interface ILiquidityAdapter {
    function availableLiquidity(address vault) external view returns (uint256);
}
