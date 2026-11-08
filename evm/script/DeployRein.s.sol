// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";
import {MockToken} from "../src/MockToken.sol";
import {MirrorVault} from "../src/MirrorVault.sol";
import {MirrorAdapter} from "../src/adapters/MirrorAdapter.sol";
import {EulerEarnAdapter} from "../src/adapters/EulerEarnAdapter.sol";
import {MorphoV2Adapter} from "../src/adapters/MorphoV2Adapter.sol";

/// @notice Deploys Rein's oracle for the current chain and registers its vaults. The broadcasting deployer owns
/// the oracle. Environment:
/// - `ATTESTER` (all chains, required): the address allowed to post verdicts.
/// - Monad (143) only: `EULER_EARN_VAULTS` and `MORPHO_V2_VAULTS`, comma-separated vault addresses (either may be
///   empty), and optional `ADAPTERS=<EulerEarnAdapter>,<MorphoV2Adapter>` to reuse deployed adapters instead of
///   deploying new ones.
/// Monad testnet (10143) and Base Sepolia (84532) each deploy their own mock USDC and three mirror vaults.
/// Base (8453) registers the vaults in shared/addresses.base.json.
contract DeployRein is Script {
    error UnsupportedChain(uint256 chainId);
    error NoVaults();
    error AdaptersLength(uint256 length);
    error ZeroAdapter();

    struct Kinds {
        address[] eulerEarn;
        address[] morphoV2;
    }

    function run() external {
        address attester = vm.envAddress("ATTESTER");
        uint256 chainId = block.chainid;
        if (chainId != 10143 && chainId != 143 && chainId != 8453 && chainId != 84532) {
            revert UnsupportedChain(chainId);
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        console.log("chain id", chainId);
        console.log("deployer (oracle owner)", deployer);
        console.log("attester", attester);

        if (chainId == 10143 || chainId == 84532) _testnet(deployer, attester);
        else if (chainId == 143) _monad(deployer, attester);
        else _base(deployer, attester);
        vm.stopBroadcast();
    }

    /// Demo feed: 1 h resolve window, no sampling, mirror vaults on a mock USDC.
    function _testnet(address deployer, address attester) internal {
        TareRiskOracle oracle = _oracle(deployer, attester, 1 hours, 0);
        MockToken usdc = new MockToken("Mock USDC", "USDC", 6);
        console.log("MockToken", address(usdc));
        // Starting stats mirror three Base vaults (APY and 1 - withdrawable share, in bps); the admin can update them.
        _mirror(oracle, usdc, deployer, "Rein Mirror Steakhouse Prime", "rmSTEAK", "Steakhouse Prime USDC", 510, 910);
        _mirror(oracle, usdc, deployer, "Rein Mirror Clearstar", "rmCSCB", "Clearstar cbAssets Vault", 649, 8010);
        _mirror(
            oracle,
            usdc,
            deployer,
            "Rein Mirror Steakhouse HY",
            "rmSIRLOIN",
            "Steakhouse High Yield USDC Edition",
            588,
            8990
        );
    }

    function _monad(address deployer, address attester) internal {
        TareRiskOracle oracle = _oracle(deployer, attester, 24 hours, 1 hours);
        Kinds memory vaults = Kinds({
            eulerEarn: vm.envOr("EULER_EARN_VAULTS", ",", new address[](0)),
            morphoV2: vm.envOr("MORPHO_V2_VAULTS", ",", new address[](0))
        });
        address[] memory adapters = vm.envOr("ADAPTERS", ",", new address[](0));
        if (adapters.length == 0) _registerNew(oracle, vaults);
        else if (adapters.length == 2) _register(oracle, vaults, adapters[0], adapters[1]);
        else revert AdaptersLength(adapters.length);
    }

    function _base(address deployer, address attester) internal {
        TareRiskOracle oracle = _oracle(deployer, attester, 24 hours, 1 hours);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/addresses.base.json"));
        _registerNew(
            oracle, Kinds({eulerEarn: _jsonVaults(json, "eulerEarn"), morphoV2: _jsonVaults(json, "morphoV2")})
        );
    }

    function _oracle(address deployer, address attester, uint64 resolveWindow, uint64 sampleWindow)
        internal
        returns (TareRiskOracle oracle)
    {
        oracle = new TareRiskOracle(deployer, attester, resolveWindow, sampleWindow);
        console.log("TareRiskOracle", address(oracle));
    }

    function _mirror(
        TareRiskOracle oracle,
        MockToken usdc,
        address admin,
        string memory name,
        string memory symbol,
        string memory mirrorOf,
        uint16 apyBps,
        uint16 utilizationBps
    ) internal {
        MirrorVault vault = new MirrorVault(usdc, name, symbol, mirrorOf, apyBps, utilizationBps, admin);
        MirrorAdapter adapter = new MirrorAdapter();
        oracle.registerVault(address(vault), address(adapter));
        console.log(string.concat("MirrorVault ", symbol), address(vault));
        console.log(string.concat("MirrorAdapter ", symbol), address(adapter));
    }

    /// Deploys one adapter per vault kind that has vaults, then registers every vault.
    function _registerNew(TareRiskOracle oracle, Kinds memory vaults) internal {
        address eulerEarn = vaults.eulerEarn.length == 0 ? address(0) : address(new EulerEarnAdapter());
        address morphoV2 = vaults.morphoV2.length == 0 ? address(0) : address(new MorphoV2Adapter());
        _register(oracle, vaults, eulerEarn, morphoV2);
    }

    function _register(TareRiskOracle oracle, Kinds memory vaults, address eulerEarn, address morphoV2) internal {
        if (vaults.eulerEarn.length + vaults.morphoV2.length == 0) revert NoVaults();
        if (vaults.eulerEarn.length != 0) {
            if (eulerEarn == address(0)) revert ZeroAdapter();
            console.log("EulerEarnAdapter", eulerEarn);
        }
        if (vaults.morphoV2.length != 0) {
            if (morphoV2 == address(0)) revert ZeroAdapter();
            console.log("MorphoV2Adapter", morphoV2);
        }
        for (uint256 i = 0; i < vaults.eulerEarn.length; i++) {
            oracle.registerVault(vaults.eulerEarn[i], eulerEarn);
            console.log("registered Euler Earn vault", vaults.eulerEarn[i]);
        }
        for (uint256 i = 0; i < vaults.morphoV2.length; i++) {
            oracle.registerVault(vaults.morphoV2[i], morphoV2);
            console.log("registered Morpho V2 vault", vaults.morphoV2[i]);
        }
    }

    function _jsonVaults(string memory json, string memory kind) internal pure returns (address[] memory vaults) {
        string memory path = string.concat(".vaults.", kind);
        string[] memory keys = vm.parseJsonKeys(json, path);
        vaults = new address[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            vaults[i] = vm.parseJsonAddress(json, string.concat(path, ".", keys[i]));
        }
    }
}
