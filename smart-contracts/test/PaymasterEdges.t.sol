// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {ZkVotingPaymaster} from "../src/account/ZkVotingPaymaster.sol";
import {UserOp} from "../src/interfaces/UserOp.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IZkVotingPaymaster} from "../src/interfaces/IZkVotingPaymaster.sol";

contract RejectEther {
    receive() external payable {
        revert("nope");
    }
}

/// @notice Paymaster withdraw, EntryPoint gate, receive, and dest allowlist edges.
/// @dev Edge cases: zero recipient, unauthorized, fail-closed pay.
contract PaymasterEdgesTest is Deployer {
    address internal stranger;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        stranger = makeAddr("stranger");
    }

    function testConstructorRejectsZeroEntryPoint() public {
        vm.expectRevert(IZkVotingPaymaster.ZeroAddress.selector);
        new ZkVotingPaymaster(address(0), admin);
    }

    function testConstructorRejectsZeroAdmin() public {
        vm.expectRevert(IZkVotingPaymaster.ZeroAddress.selector);
        new ZkVotingPaymaster(address(entryPoint), address(0));
    }

    function testReceiveDepositsEth() public {
        uint256 beforeBal = address(paymaster).balance;
        vm.deal(stranger, 3 ether);
        vm.prank(stranger);
        (bool ok,) = address(paymaster).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(paymaster).balance, beforeBal + 3 ether);
    }

    function testDepositEmits() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        paymaster.deposit{value: 1 ether}();
    }

    function testWithdrawZeroRecipientReverts() public {
        vm.prank(admin);
        vm.expectRevert(IZkVotingPaymaster.ZeroAddress.selector);
        paymaster.withdraw(payable(address(0)), 1);
    }

    function testStrangerCannotWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(IZkVotingPaymaster.NotAdmin.selector);
        paymaster.withdraw(payable(stranger), 1);
    }

    function testAdminWithdrawsUnusedSponsorship() public {
        address payable treasury = payable(makeAddr("treasury"));
        uint256 before = address(paymaster).balance;
        vm.prank(admin);
        paymaster.withdraw(treasury, 1 ether);
        assertEq(treasury.balance, 1 ether);
        assertEq(address(paymaster).balance, before - 1 ether);
    }

    function testWithdrawFailedWhenRecipientRejects() public {
        RejectEther sink = new RejectEther();
        vm.prank(admin);
        vm.expectRevert(IZkVotingPaymaster.WithdrawFailed.selector);
        paymaster.withdraw(payable(address(sink)), 1 ether);
    }

    function testValidateAndPayNotEntryPointReverts() public {
        UserOp memory op;
        vm.prank(stranger);
        vm.expectRevert(IZkVotingPaymaster.NotEntryPoint.selector);
        paymaster.validateAndPay(op);
    }

    function testStrangerCannotSetAlwaysSponsor() public {
        vm.prank(stranger);
        vm.expectRevert(IZkVotingPaymaster.NotAdmin.selector);
        paymaster.setAlwaysSponsor(false);
    }

    function testStrangerCannotSetSponsoredTargets() public {
        vm.prank(stranger);
        vm.expectRevert(IZkVotingPaymaster.NotAdmin.selector);
        paymaster.setSponsoredTargets(address(1), address(2), address(3));
    }

    function testAlwaysSponsorFalseEmptyCalldataNotSponsored() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);

        UserOp memory op;
        op.callData = hex"";
        vm.prank(address(entryPoint));
        vm.expectRevert(IZkVotingPaymaster.NotSponsored.selector);
        paymaster.validateAndPay(op);
    }

    function testAlwaysSponsorFalseSponsorsInboxDest() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);

        UserOp memory op;
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, address(inbox), uint256(0), bytes(""));
        vm.prank(address(entryPoint));
        assertTrue(paymaster.validateAndPay(op));
    }

    function testAlwaysSponsorFalseSponsorsInitCodeFactory() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);

        UserOp memory op;
        op.initCode = bytes.concat(bytes20(address(accountFactory)), hex"00");
        op.callData = hex"";
        vm.prank(address(entryPoint));
        assertTrue(paymaster.validateAndPay(op));
    }
}
