// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MorphoV2Adapter} from "../src/adapters/MorphoV2Adapter.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";

/// @notice Checks the Base vaults in shared/addresses.base.json against live chain state.
/// Run with `forge test --match-contract ForkBaseTest --fork-url https://mainnet.base.org`; skipped without a Base fork.
contract ForkBaseTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant MIN_TVL = 1_000_000e6;

    string json;
    MorphoV2Adapter adapter;
    TareRiskOracle oracle;

    function setUp() public {
        if (block.chainid != 8453) vm.skip(true, "needs a Base fork");
        json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/addresses.base.json"));
        adapter = new MorphoV2Adapter();
        oracle = new TareRiskOracle(address(this), makeAddr("attester"), 24 hours, 1 hours);
    }

    function _vault(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, string.concat(".vaults.morphoV2.", key));
    }

    /// Rule 5: the adapter reads above 0 and at most TVL.
    function _adapterReadsInRange(string memory key) internal view {
        address vault = _vault(key);
        uint256 liquidity = adapter.availableLiquidity(vault);
        assertGt(liquidity, 0, "adapter reads 0");
        assertLe(liquidity, IERC4626(vault).totalAssets(), "adapter reads above TVL");
    }

    /// The oracle can snapshot the vault once registered with the adapter; rules 1 and 3 hold.
    function _metricsOf(string memory key) internal {
        address vault = _vault(key);
        oracle.registerVault(vault, address(adapter));
        (uint256 pps, uint256 assets, uint256 liquidity) = oracle.metricsOf(vault);
        assertEq(IERC4626(vault).asset(), USDC, "asset is not USDC");
        assertGt(pps, 0, "share price is 0");
        assertGe(assets, MIN_TVL, "TVL below $1M");
        assertEq(liquidity, adapter.availableLiquidity(vault), "liquidity is not the adapter read");
    }

    function test_fork_adapterReadsInRange_groveSteakUSDC() public view {
        _adapterReadsInRange("groveSteakUSDC");
    }

    function test_fork_metricsOf_groveSteakUSDC() public {
        _metricsOf("groveSteakUSDC");
    }

    function test_fork_adapterReadsInRange_sirloinUSDC() public view {
        _adapterReadsInRange("sirloinUSDC");
    }

    function test_fork_metricsOf_sirloinUSDC() public {
        _metricsOf("sirloinUSDC");
    }

    function test_fork_adapterReadsInRange_steakUSDC() public view {
        _adapterReadsInRange("steakUSDC");
    }

    function test_fork_metricsOf_steakUSDC() public {
        _metricsOf("steakUSDC");
    }

    function test_fork_adapterReadsInRange_gtUSDCp() public view {
        _adapterReadsInRange("gtUSDCp");
    }

    function test_fork_metricsOf_gtUSDCp() public {
        _metricsOf("gtUSDCp");
    }

    function test_fork_adapterReadsInRange_ethenaUSDC() public view {
        _adapterReadsInRange("ethenaUSDC");
    }

    function test_fork_metricsOf_ethenaUSDC() public {
        _metricsOf("ethenaUSDC");
    }

    function test_fork_adapterReadsInRange_cscbUSDC() public view {
        _adapterReadsInRange("cscbUSDC");
    }

    function test_fork_metricsOf_cscbUSDC() public {
        _metricsOf("cscbUSDC");
    }

    function test_fork_adapterReadsInRange_bbqUSDC() public view {
        _adapterReadsInRange("bbqUSDC");
    }

    function test_fork_metricsOf_bbqUSDC() public {
        _metricsOf("bbqUSDC");
    }

    function test_fork_adapterReadsInRange_gtUSDCf() public view {
        _adapterReadsInRange("gtUSDCf");
    }

    function test_fork_metricsOf_gtUSDCf() public {
        _metricsOf("gtUSDCf");
    }

    function test_fork_adapterReadsInRange_kpkUSDCYield() public view {
        _adapterReadsInRange("kpkUSDCYield");
    }

    function test_fork_metricsOf_kpkUSDCYield() public {
        _metricsOf("kpkUSDCYield");
    }

    function test_fork_adapterReadsInRange_k3USDC() public view {
        _adapterReadsInRange("k3USDC");
    }

    function test_fork_metricsOf_k3USDC() public {
        _metricsOf("k3USDC");
    }

    function test_fork_adapterReadsInRange_noonEcoUSDC() public view {
        _adapterReadsInRange("noonEcoUSDC");
    }

    function test_fork_metricsOf_noonEcoUSDC() public {
        _metricsOf("noonEcoUSDC");
    }

    function test_fork_adapterReadsInRange_bitUSDCp() public view {
        _adapterReadsInRange("bitUSDCp");
    }

    function test_fork_metricsOf_bitUSDCp() public {
        _metricsOf("bitUSDCp");
    }

    function test_fork_adapterReadsInRange_gUSDCq() public view {
        _adapterReadsInRange("gUSDCq");
    }

    function test_fork_metricsOf_gUSDCq() public {
        _metricsOf("gUSDCq");
    }

    function test_fork_adapterReadsInRange_re7USDC() public view {
        _adapterReadsInRange("re7USDC");
    }

    function test_fork_metricsOf_re7USDC() public {
        _metricsOf("re7USDC");
    }
}
