// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MorphoV2Adapter} from "../src/adapters/MorphoV2Adapter.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";
import {GuardianV2} from "../src/GuardianV2.sol";

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @dev Minimal slice of Morpho Blue.
interface IMorpho {
    function market(bytes32 id)
        external
        view
        returns (uint128 totalSupplyAssets, uint128, uint128 totalBorrowAssets, uint128, uint128, uint128);
    function position(bytes32 id, address user) external view returns (uint256, uint128 borrowShares, uint128);
    function supplyCollateral(MarketParams memory params, uint256 assets, address onBehalf, bytes memory data) external;
    function borrow(MarketParams memory params, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function repay(MarketParams memory params, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
}

interface IMorphoVaultV2 {
    function liquidityAdapter() external view returns (address);
    function liquidityData() external view returns (bytes memory);
}

interface IMorphoMarketAdapter {
    function morpho() external view returns (address);
}

interface IMorphoOracle {
    function price() external view returns (uint256);
}

/// @notice GuardianV2 against the Base vaults in shared/addresses.base.json on live chain state.
/// Run with `forge test --match-contract ForkGuardianTest --fork-url https://mainnet.base.org`; skipped without a Base fork.
contract ForkGuardianTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant POSITION = 1_000e6;

    string json;
    TareRiskOracle oracle;
    GuardianV2 guardian;
    address attester = makeAddr("attester");
    address user = makeAddr("user");
    address borrower = makeAddr("borrower");

    function setUp() public {
        if (block.chainid != 8453) vm.skip(true, "needs a Base fork");
        json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/addresses.base.json"));
        oracle = new TareRiskOracle(address(this), attester, 24 hours, 1 hours);
        guardian = new GuardianV2(address(this), oracle);
    }

    /// @dev Registers and approves the vault, deposits 1,000 USDC for `user`, opts in and posts an EXIT verdict.
    function _ready(string memory key) internal returns (address vault) {
        vault = vm.parseJsonAddress(json, string.concat(".vaults.morphoV2.", key));
        oracle.registerVault(vault, address(new MorphoV2Adapter()));
        guardian.setVaultApproved(vault, true);
        deal(USDC, user, POSITION);
        vm.startPrank(user);
        IERC20(USDC).approve(vault, POSITION);
        // A vault at its deposit cap refuses the setup deposit. Exits aren't capped, but there is no position to test.
        try IERC4626(vault).deposit(POSITION, user) {}
        catch (bytes memory reason) {
            if (bytes4(reason) != bytes4(keccak256("AbsoluteCapExceeded()"))) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            vm.stopPrank();
            vm.skip(true, "vault is at its deposit cap; the setup deposit is refused");
        }
        IERC20(vault).approve(address(guardian), type(uint256).max);
        guardian.enable(vault, 9000, 600);
        vm.stopPrank();
        vm.prank(attester);
        oracle.post(vault, TareRiskOracle.Verdict.EXIT, 9500, 8000, keccak256("state"), type(uint64).max);
    }

    /// @dev Lowest gas `exit` can be called with and still reach the redeem, i.e. arrive there with exactly
    /// MIN_EXIT_GAS left.
    function _lowestAdmittedGas(address vault) internal returns (uint256 lo) {
        lo = guardian.MIN_EXIT_GAS();
        uint256 hi = lo + 200_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            bool tooLow;
            try guardian.exit{gas: mid}(vault, user) {}
            catch (bytes memory err) {
                tooLow = bytes4(err) == GuardianV2.GasTooLow.selector;
            }
            vm.revertToState(snap);
            if (tooLow) lo = mid + 1;
            else hi = mid;
        }
    }

    /// Rule 4: Guardian fully exits 1,000 USDC.
    function _fullExit1000(string memory key) internal {
        address vault = _ready(key);
        uint256 assets = guardian.exit(vault, user);
        assertEq(IERC20(vault).balanceOf(user), 0, "shares left");
        assertApproxEqAbs(assets, POSITION, 1, "assets out");
        assertEq(IERC20(USDC).balanceOf(user), assets, "USDC to owner");
    }

    /// With the least gas the floor admits, the exit is still full; one gas less reverts GasTooLow.
    function _cannotForcePartialLowGas(string memory key) internal {
        address vault = _ready(key);
        uint256 g = _lowestAdmittedGas(vault);
        vm.expectRevert(GuardianV2.GasTooLow.selector);
        guardian.exit{gas: g - 1}(vault, user);
        guardian.exit{gas: g}(vault, user);
        assertEq(IERC20(vault).balanceOf(user), 0, "partial exit at the floor");
    }

    /// A borrow in the same transaction leaves the vault able to pay out only half the position: the exit is
    /// partial, and a follow-up exit on the same verdict completes once the borrow is repaid.
    function _borrowSameTxPartialThenFollowUp(string memory key) internal {
        address vault = _ready(key);
        IMorphoVaultV2 v = IMorphoVaultV2(vault);
        MarketParams memory mp = abi.decode(v.liquidityData(), (MarketParams));
        IMorpho morpho = IMorpho(IMorphoMarketAdapter(v.liquidityAdapter()).morpho());
        bytes32 id = keccak256(abi.encode(mp));

        uint256 idle = IERC20(USDC).balanceOf(vault);
        // With that much idle USDC a borrow can't shrink what the vault pays out, so there is no partial to force.
        if (idle >= POSITION / 2) vm.skip(true, "idle USDC covers half the position; a borrow cannot force a partial");
        (uint256 supplied,, uint256 borrowed,,,) = morpho.market(id);
        uint256 amount = supplied - borrowed - (POSITION / 2 - idle);
        uint256 collateral = amount * 1e36 / IMorphoOracle(mp.oracle).price() * 1e18 / mp.lltv * 2;
        deal(mp.collateralToken, borrower, collateral);
        vm.startPrank(borrower);
        IERC20(mp.collateralToken).approve(address(morpho), collateral);
        morpho.supplyCollateral(mp, collateral, borrower, "");
        morpho.borrow(mp, amount, 0, borrower, borrower);
        vm.stopPrank();

        uint256 first = guardian.exit(vault, user);
        assertGt(first, 0, "nothing exited");
        assertGt(IERC20(vault).balanceOf(user), 0, "exit was full");

        (, uint128 debt,) = morpho.position(id, borrower);
        deal(USDC, borrower, amount * 2);
        vm.startPrank(borrower);
        IERC20(USDC).approve(address(morpho), amount * 2);
        morpho.repay(mp, 0, debt, borrower, "");
        vm.stopPrank();

        uint256 second = guardian.exit(vault, user);
        assertEq(IERC20(vault).balanceOf(user), 0, "follow-up left shares");
        assertApproxEqAbs(first + second, POSITION, 2, "assets out");
    }

    function test_fork_fullExit1000_groveSteakUSDC() public {
        _fullExit1000("groveSteakUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_groveSteakUSDC() public {
        _cannotForcePartialLowGas("groveSteakUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_groveSteakUSDC() public {
        _borrowSameTxPartialThenFollowUp("groveSteakUSDC");
    }

    function test_fork_fullExit1000_sirloinUSDC() public {
        _fullExit1000("sirloinUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_sirloinUSDC() public {
        _cannotForcePartialLowGas("sirloinUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_sirloinUSDC() public {
        _borrowSameTxPartialThenFollowUp("sirloinUSDC");
    }

    function test_fork_fullExit1000_steakUSDC() public {
        _fullExit1000("steakUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_steakUSDC() public {
        _cannotForcePartialLowGas("steakUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_steakUSDC() public {
        _borrowSameTxPartialThenFollowUp("steakUSDC");
    }

    function test_fork_fullExit1000_gtUSDCp() public {
        _fullExit1000("gtUSDCp");
    }

    function test_fork_cannotForcePartial_lowGas_gtUSDCp() public {
        _cannotForcePartialLowGas("gtUSDCp");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_gtUSDCp() public {
        _borrowSameTxPartialThenFollowUp("gtUSDCp");
    }

    function test_fork_fullExit1000_ethenaUSDC() public {
        _fullExit1000("ethenaUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_ethenaUSDC() public {
        _cannotForcePartialLowGas("ethenaUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_ethenaUSDC() public {
        _borrowSameTxPartialThenFollowUp("ethenaUSDC");
    }

    function test_fork_fullExit1000_cscbUSDC() public {
        _fullExit1000("cscbUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_cscbUSDC() public {
        _cannotForcePartialLowGas("cscbUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_cscbUSDC() public {
        _borrowSameTxPartialThenFollowUp("cscbUSDC");
    }

    function test_fork_fullExit1000_bbqUSDC() public {
        _fullExit1000("bbqUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_bbqUSDC() public {
        _cannotForcePartialLowGas("bbqUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_bbqUSDC() public {
        _borrowSameTxPartialThenFollowUp("bbqUSDC");
    }

    function test_fork_fullExit1000_gtUSDCf() public {
        _fullExit1000("gtUSDCf");
    }

    function test_fork_cannotForcePartial_lowGas_gtUSDCf() public {
        _cannotForcePartialLowGas("gtUSDCf");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_gtUSDCf() public {
        _borrowSameTxPartialThenFollowUp("gtUSDCf");
    }

    function test_fork_fullExit1000_kpkUSDCYield() public {
        _fullExit1000("kpkUSDCYield");
    }

    function test_fork_cannotForcePartial_lowGas_kpkUSDCYield() public {
        _cannotForcePartialLowGas("kpkUSDCYield");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_kpkUSDCYield() public {
        _borrowSameTxPartialThenFollowUp("kpkUSDCYield");
    }

    function test_fork_fullExit1000_k3USDC() public {
        _fullExit1000("k3USDC");
    }

    function test_fork_cannotForcePartial_lowGas_k3USDC() public {
        _cannotForcePartialLowGas("k3USDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_k3USDC() public {
        _borrowSameTxPartialThenFollowUp("k3USDC");
    }

    function test_fork_fullExit1000_noonEcoUSDC() public {
        _fullExit1000("noonEcoUSDC");
    }

    function test_fork_cannotForcePartial_lowGas_noonEcoUSDC() public {
        _cannotForcePartialLowGas("noonEcoUSDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_noonEcoUSDC() public {
        _borrowSameTxPartialThenFollowUp("noonEcoUSDC");
    }

    function test_fork_fullExit1000_bitUSDCp() public {
        _fullExit1000("bitUSDCp");
    }

    function test_fork_cannotForcePartial_lowGas_bitUSDCp() public {
        _cannotForcePartialLowGas("bitUSDCp");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_bitUSDCp() public {
        _borrowSameTxPartialThenFollowUp("bitUSDCp");
    }

    function test_fork_fullExit1000_gUSDCq() public {
        _fullExit1000("gUSDCq");
    }

    function test_fork_cannotForcePartial_lowGas_gUSDCq() public {
        _cannotForcePartialLowGas("gUSDCq");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_gUSDCq() public {
        _borrowSameTxPartialThenFollowUp("gUSDCq");
    }

    function test_fork_fullExit1000_re7USDC() public {
        _fullExit1000("re7USDC");
    }

    function test_fork_cannotForcePartial_lowGas_re7USDC() public {
        _cannotForcePartialLowGas("re7USDC");
    }

    function test_fork_borrowSameTx_partialThenFollowUpCompletes_re7USDC() public {
        _borrowSameTxPartialThenFollowUp("re7USDC");
    }
}
