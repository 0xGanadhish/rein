// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GuardianV2} from "../src/GuardianV2.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";

/// @notice Deploys GuardianV2 against an existing oracle and approves the given vaults, in one broadcast. The
/// broadcasting deployer is the Guardian's admin. Environment:
/// - `ORACLE` (required): the TareRiskOracle the Guardian reads verdicts from.
/// - `VAULTS` (required): comma-separated vault addresses to approve.
contract DeployGuardian is Script {
    error NoVaults();

    function run() external {
        TareRiskOracle oracle = TareRiskOracle(vm.envAddress("ORACLE"));
        address[] memory vaults = vm.envAddress("VAULTS", ",");
        if (vaults.length == 0) revert NoVaults();

        vm.startBroadcast();
        (, address admin,) = vm.readCallers();
        GuardianV2 guardian = new GuardianV2(admin, oracle);
        console.log("GuardianV2", address(guardian));
        for (uint256 i = 0; i < vaults.length; i++) {
            guardian.setVaultApproved(vaults[i], true);
            console.log("approved vault", vaults[i]);
        }
        vm.stopBroadcast();
    }
}
