// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockToken} from "../src/MockToken.sol";
import {MirrorVault} from "../src/MirrorVault.sol";
import {MirrorAdapter} from "../src/adapters/MirrorAdapter.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";
import {GuardianV2} from "../src/GuardianV2.sol";

contract GuardianV2Test is Test {
    MockToken usdc;
    MirrorVault vault;
    TareRiskOracle oracle;
    GuardianV2 guardian;
    address admin = makeAddr("admin");
    address attester = makeAddr("attester");
    address user = makeAddr("user");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockToken("Mock USDC", "USDC", 6);
        vault = new MirrorVault(usdc, "Mirror Vault", "mUSDC", "Mirror", 0, 0, admin);
        oracle = new TareRiskOracle(address(this), attester, 3600, 0);
        oracle.registerVault(address(vault), address(new MirrorAdapter()));
        guardian = new GuardianV2(admin, oracle);
        vm.prank(admin);
        guardian.setVaultApproved(address(vault), true);

        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(vault), 1_000e6);
        vault.deposit(1_000e6, user);
        vault.approve(address(guardian), type(uint256).max);
        guardian.enable(address(vault), 9000, 600);
        vm.stopPrank();
        vm.prank(attester);
        oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9500, 8000, keccak256("state"), type(uint64).max);
    }

    /// @dev Lowest gas `exit` can be called with and still reach the redeem, i.e. arrive there with exactly
    /// MIN_EXIT_GAS left.
    function _lowestAdmittedGas() internal returns (uint256 lo) {
        lo = guardian.MIN_EXIT_GAS();
        uint256 hi = lo + 200_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            bool tooLow;
            try guardian.exit{gas: mid}(address(vault), user) {}
            catch (bytes memory err) {
                tooLow = bytes4(err) == GuardianV2.GasTooLow.selector;
            }
            vm.revertToState(snap);
            if (tooLow) lo = mid + 1;
            else hi = mid;
        }
    }

    function test_exit_revertsGasTooLow_whenGasUnderFloor() public {
        uint256 floor = guardian.MIN_EXIT_GAS();
        vm.expectRevert(GuardianV2.GasTooLow.selector);
        guardian.exit{gas: floor - 1}(address(vault), user);

        uint256 g = _lowestAdmittedGas();
        vm.expectRevert(GuardianV2.GasTooLow.selector);
        guardian.exit{gas: g - 1}(address(vault), user);
        assertEq(vault.balanceOf(user), 1_000e6);
    }

    function test_exit_fullRedeem_atFloor() public {
        uint256 g = _lowestAdmittedGas();
        uint256 assets = guardian.exit{gas: g}(address(vault), user);
        assertEq(assets, 1_000e6);
        assertEq(vault.balanceOf(user), 0);
        assertEq(usdc.balanceOf(user), 1_000e6);
    }
}
