// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockToken} from "../src/MockToken.sol";
import {MirrorVault} from "../src/MirrorVault.sol";
import {MirrorAdapter} from "../src/adapters/MirrorAdapter.sol";
import {TareRiskOracle} from "../src/TareRiskOracle.sol";

contract TareRiskOracleTest is Test {
    event VerdictPosted(
        uint256 indexed id,
        address indexed vault,
        TareRiskOracle.Verdict verdict,
        uint16 confidenceBps,
        uint16 riskBps,
        bytes32 stateHash,
        uint64 postedAt
    );

    MockToken usdc;
    MirrorVault vault;
    MirrorAdapter adapter;
    TareRiskOracle oracle;
    address owner = makeAddr("owner");
    address attester = makeAddr("attester");
    address admin = makeAddr("admin");
    address user = makeAddr("user");
    address other = makeAddr("other");
    bytes32 constant HASH = keccak256("state");

    function setUp() public {
        usdc = new MockToken("Mock USDC", "USDC", 6);
        vault = new MirrorVault(usdc, "Mirror Vault", "mUSDC", unicode"Clearstar USDC · Euler", 600, 7100, admin);
        adapter = new MirrorAdapter();
        oracle = new TareRiskOracle(owner, attester, 3600, 0);
        usdc.mint(user, 40_000e6);
        vm.startPrank(user);
        usdc.approve(address(vault), 40_000e6);
        vault.deposit(40_000e6, user);
        vm.stopPrank();
        vm.prank(owner);
        oracle.registerVault(address(vault), address(adapter));
    }

    function _post() internal returns (uint256) {
        vm.prank(attester);
        return oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH);
    }

    function test_constructor_setsRoles() public view {
        assertEq(oracle.owner(), owner);
        assertEq(oracle.attester(), attester);
        assertEq(oracle.resolveWindow(), 3600);
        assertEq(oracle.postCount(), 0);
    }

    function test_post_onlyAttester() public {
        vm.prank(other);
        vm.expectRevert(TareRiskOracle.NotAttester.selector);
        oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH);
    }

    function test_post_requiresRegisteredVault() public {
        vm.prank(attester);
        vm.expectRevert(TareRiskOracle.VaultNotRegistered.selector);
        oracle.post(other, TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH);
    }

    function test_post_rejectsBpsOver10000() public {
        vm.startPrank(attester);
        vm.expectRevert(TareRiskOracle.BpsOutOfRange.selector);
        oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 10_001, 8000, HASH);
        vm.expectRevert(TareRiskOracle.BpsOutOfRange.selector);
        oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9200, 10_001, HASH);
        vm.stopPrank();
    }

    function test_post_snapshotsMetrics() public {
        vm.warp(1_000_000);
        vm.expectEmit(address(oracle));
        emit VerdictPosted(1, address(vault), TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH, 1_000_000);
        uint256 id = _post();
        assertEq(id, 1);
        assertEq(oracle.latest(address(vault)), 1);
        assertEq(oracle.postCount(), 1);
        TareRiskOracle.Post memory p = oracle.getPost(id);
        assertEq(p.vault, address(vault));
        assertEq(uint8(p.verdict), uint8(TareRiskOracle.Verdict.EXIT));
        assertEq(p.confidenceBps, 9200);
        assertEq(p.riskBps, 8000);
        assertEq(p.stateHash, HASH);
        assertEq(p.postedAt, 1_000_000);
        assertEq(p.ppsAtPost, vault.convertToAssets(10 ** vault.decimals()));
        assertEq(p.assetsAtPost, vault.totalAssets());
        assertEq(p.liquidityAtPost, adapter.availableLiquidity(address(vault)));
        assertFalse(oracle.getResolution(id).resolved);
    }

    function test_post_idsIncrementAndLatestTracksPerVault() public {
        _post();
        uint256 id2 = _post();
        assertEq(id2, 2);
        assertEq(oracle.latest(address(vault)), 2);
        assertEq(oracle.latest(other), 0);
    }

    function test_post_noAdapter_liquidityMax() public {
        MirrorVault bare = new MirrorVault(usdc, "Bare", "bUSDC", "Bare", 0, 0, admin);
        vm.prank(owner);
        oracle.registerVault(address(bare), address(0));
        vm.prank(attester);
        uint256 id = oracle.post(address(bare), TareRiskOracle.Verdict.HOLD, 9000, 100, HASH);
        assertEq(oracle.getPost(id).liquidityAtPost, type(uint256).max);
        assertTrue(oracle.registered(address(bare)));
        assertEq(oracle.adapterOf(address(bare)), address(0));
    }

    function test_registerVault_onlyOwner() public {
        vm.prank(other);
        vm.expectRevert(TareRiskOracle.NotOwner.selector);
        oracle.registerVault(other, address(adapter));
    }

    function test_registerVault_adapterLockedAfterFirstPost() public {
        vm.prank(owner);
        oracle.registerVault(address(vault), address(0));
        assertEq(oracle.adapterOf(address(vault)), address(0));
        vm.prank(owner);
        oracle.registerVault(address(vault), address(adapter));
        _post();
        vm.prank(owner);
        vm.expectRevert(TareRiskOracle.AdapterLocked.selector);
        oracle.registerVault(address(vault), address(0));
    }

    function test_setAttester_onlyOwner_rotates() public {
        vm.prank(other);
        vm.expectRevert(TareRiskOracle.NotOwner.selector);
        oracle.setAttester(other);
        vm.prank(owner);
        oracle.setAttester(other);
        assertEq(oracle.attester(), other);
        vm.prank(attester);
        vm.expectRevert(TareRiskOracle.NotAttester.selector);
        oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH);
        vm.prank(other);
        assertEq(oracle.post(address(vault), TareRiskOracle.Verdict.EXIT, 9200, 8000, HASH), 1);
    }
}
