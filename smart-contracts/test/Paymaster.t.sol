// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {ZkVotingPaymaster} from "../src/account/ZkVotingPaymaster.sol";
import {UserOp} from "../src/account/ZkVotingEntryPoint.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

contract PaymasterSink {
    uint256 public value;

    function ping(uint256 v) external {
        value = v;
    }
}

/// @notice Gasless civic sponsorship via `alwaysSponsor`.
contract PaymasterTest is Deployer {
    PaymasterSink internal sink;
    address internal account;
    uint256 internal voterPk;
    address internal voter;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();

        sink = new PaymasterSink();
        voterPk = 0xA11CE;
        voter = vm.addr(voterPk);
        vm.deal(voter, 5 ether);

        account = accountFactory.createAccountWithBackupSigner(keccak256("cred-paymaster"), 1, 2, voter, bytes32(uint256(7)));
        vm.label(account, "passkeyAccount");
        vm.label(voter, "voterEoa");
    }

    function testAlwaysSponsorDefaultsTrueAndPays() public {
        assertTrue(paymaster.alwaysSponsor(), "alwaysSponsor");

        UserOp memory op;
        op.sender = account;
        op.callData = abi.encodeWithSelector(PasskeyAccount.execute.selector, makeAddr("anyDest"), uint256(0), bytes(""));
        op.paymaster = address(paymaster);

        vm.prank(address(entryPoint));
        assertTrue(paymaster.validateAndPay(op), "sponsors when alwaysSponsor");
    }

    function testHandleOpsDoesNotDebitVoterWhenAlwaysSponsor() public {
        uint256 voterBefore = voter.balance;
        uint256 accountBefore = account.balance;

        UserOp[] memory ops = new UserOp[](1);
        ops[0] = signedExecuteOp(account, address(sink), abi.encodeCall(PaymasterSink.ping, (42)), voterPk, 0);

        vm.prank(relayer);
        entryPoint.handleOps(ops);

        assertEq(sink.value(), 42);
        assertEq(voter.balance, voterBefore, "voter EOA is not charged");
        assertEq(account.balance, accountBefore, "passkey account is not charged");
        assertTrue(paymaster.alwaysSponsor());
    }

    function testAlwaysSponsorFalseRequiresSponsoredTarget() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);
        vm.prank(admin);
        paymaster.setSponsoredTargets(address(inbox), address(voterRegistry), address(accountFactory));

        bytes memory inboxCall =
            abi.encodeWithSelector(PasskeyAccount.execute.selector, address(inbox), uint256(0), bytes(""));
        UserOp memory sponsored;
        sponsored.sender = account;
        sponsored.callData = inboxCall;
        sponsored.paymaster = address(paymaster);

        vm.prank(address(entryPoint));
        assertTrue(paymaster.validateAndPay(sponsored));

        bytes memory otherCall =
            abi.encodeWithSelector(PasskeyAccount.execute.selector, address(sink), uint256(0), bytes(""));
        UserOp memory unsponsored;
        unsponsored.sender = account;
        unsponsored.callData = otherCall;
        unsponsored.paymaster = address(paymaster);

        vm.prank(address(entryPoint));
        vm.expectRevert(ZkVotingPaymaster.NotSponsored.selector);
        paymaster.validateAndPay(unsponsored);
    }

    function testAdminCanToggleAlwaysSponsor() public {
        vm.prank(admin);
        paymaster.setAlwaysSponsor(false);
        assertFalse(paymaster.alwaysSponsor());

        vm.prank(relayer);
        vm.expectRevert(ZkVotingPaymaster.NotAdmin.selector);
        paymaster.setAlwaysSponsor(true);

        vm.prank(admin);
        paymaster.setAlwaysSponsor(true);
        assertTrue(paymaster.alwaysSponsor());
    }

    function testDepositFundsPaymaster() public {
        uint256 beforeBal = address(paymaster).balance;
        paymaster.deposit{value: 1 ether}();
        assertEq(address(paymaster).balance, beforeBal + 1 ether);
    }
}
