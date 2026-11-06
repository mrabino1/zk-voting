// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.
// Checkpoints, delegation, and the two signature paths. No civic election is deployed.

import {Test} from "forge-std/Test.sol";
import {ISignalUnderlying, SignalVotes} from "../../src/token/SignalVotes.sol";
import {SignalVotesToken} from "../../src/token/SignalVotesToken.sol";
import {SignalVotesWrapper} from "../../src/token/SignalVotesWrapper.sol";

contract MockERC20 is ISignalUnderlying {
    string public name = "Mock";
    string public symbol = "MCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract SignalVotesTokenTest is Test {
    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;

    SignalVotesToken internal token;
    address internal alice;
    address internal bob;
    address internal cara;

    function setUp() public {
        alice = vm.addr(ALICE_KEY);
        bob = vm.addr(BOB_KEY);
        cara = makeAddr("cara");
        token = new SignalVotesToken("Signal Votes", "SV", alice, 1_000_000 ether);
    }

    function test_clockIsBlockNumber() public view {
        assertEq(token.clock(), uint48(block.number));
        assertEq(keccak256(bytes(token.CLOCK_MODE())), keccak256(bytes("mode=blocknumber&from=default")));
    }

    function test_undelegatedBalanceHasZeroVotes() public view {
        assertEq(token.balanceOf(alice), 1_000_000 ether);
        assertEq(token.getVotes(alice), 0);
        assertEq(token.delegates(alice), address(0));
    }

    function test_selfDelegateActivatesVotingPower() public {
        vm.prank(alice);
        token.delegate(alice);
        assertEq(token.delegates(alice), alice);
        assertEq(token.getVotes(alice), 1_000_000 ether);
    }

    function test_delegateMovesPowerAndRedelegateMovesItAgain() public {
        vm.prank(alice);
        token.delegate(bob);
        assertEq(token.getVotes(alice), 0);
        assertEq(token.getVotes(bob), 1_000_000 ether);

        vm.prank(alice);
        token.delegate(cara);
        assertEq(token.getVotes(bob), 0);
        assertEq(token.getVotes(cara), 1_000_000 ether);
    }

    function test_undelegateToZeroAndBackToSelf() public {
        vm.startPrank(alice);
        token.delegate(bob);
        token.delegate(address(0));
        assertEq(token.getVotes(bob), 0);
        assertEq(token.getVotes(alice), 0);
        token.delegate(alice);
        assertEq(token.getVotes(alice), 1_000_000 ether);
        vm.stopPrank();
    }

    function test_transferMovesDelegatedPowerOnly() public {
        vm.prank(alice);
        token.delegate(alice);
        vm.prank(alice);
        token.transfer(bob, 400 ether);
        // Bob has not delegated, so the 400 creates no votes.
        assertEq(token.getVotes(alice), 999_600 ether);
        assertEq(token.getVotes(bob), 0);
        assertEq(token.balanceOf(bob), 400 ether);

        vm.prank(bob);
        token.delegate(bob);
        assertEq(token.getVotes(bob), 400 ether);
        assertEq(_sumVotes(), token.totalSupply());
    }

    function test_getPastVotesAfterTransferAndRedelegation() public {
        // Absolute heights. via_ir may treat `block.number` as constant inside one call, so a
        // snapshot taken as `block.number` can be moved to after `vm.roll`.
        vm.roll(10);
        vm.prank(alice);
        token.delegate(alice);

        vm.roll(11);
        vm.prank(alice);
        token.transfer(bob, 250 ether);
        vm.prank(bob);
        token.delegate(cara);

        vm.roll(12);
        vm.prank(alice);
        token.delegate(bob);

        vm.roll(13);
        assertEq(token.getPastVotes(alice, 10), 1_000_000 ether);
        assertEq(token.getPastVotes(cara, 10), 0);
        assertEq(token.getPastVotes(alice, 11), 999_750 ether);
        assertEq(token.getPastVotes(cara, 11), 250 ether);
        assertEq(token.getPastVotes(bob, 12), 999_750 ether);
        assertEq(token.getPastTotalSupply(10), 1_000_000 ether);
    }

    function test_getPastVotesRevertsOnCurrentBlock() public {
        vm.prank(alice);
        token.delegate(alice);
        vm.expectRevert(abi.encodeWithSignature("FutureLookup(uint256)", block.number));
        token.getPastVotes(alice, block.number);
    }

    function test_delegateBySigAndReplayAndExpiry() public {
        uint256 expiry = block.timestamp + 1 days;
        uint256 nonce = token.nonces(alice);
        bytes32 digest = _delegationDigest(alice, nonce, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, digest);
        token.delegateBySig(alice, nonce, expiry, v, r, s);
        assertEq(token.getVotes(alice), 1_000_000 ether);

        vm.expectRevert(SignalVotes.InvalidNonce.selector);
        token.delegateBySig(alice, nonce, expiry, v, r, s);

        uint256 expired = block.timestamp - 1;
        uint256 bobNonce = token.nonces(bob);
        bytes32 oldDigest = _delegationDigest(bob, bobNonce, expired);
        (v, r, s) = vm.sign(BOB_KEY, oldDigest);
        vm.expectRevert(abi.encodeWithSignature("ExpiredSignature(uint256)", expired));
        token.delegateBySig(bob, bobNonce, expired, v, r, s);
    }

    function test_permitReplayAndExpiry() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(alice);
        bytes32 digest = _permitDigest(alice, bob, 5 ether, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, digest);
        token.permit(alice, bob, 5 ether, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), 5 ether);

        vm.expectRevert(SignalVotes.BadSignature.selector);
        token.permit(alice, bob, 5 ether, deadline, v, r, s);

        uint256 expired = block.timestamp - 1;
        uint256 bobNonce = token.nonces(bob);
        bytes32 oldDigest = _permitDigest(bob, cara, 1 ether, bobNonce, expired);
        (v, r, s) = vm.sign(BOB_KEY, oldDigest);
        vm.expectRevert(abi.encodeWithSignature("ExpiredSignature(uint256)", expired));
        token.permit(bob, cara, 1 ether, expired, v, r, s);
    }

    function test_permitConsumesTheSharedNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(alice);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, _permitDigest(alice, bob, 1 ether, nonce, deadline));
        token.permit(alice, bob, 1 ether, deadline, v, r, s);

        uint256 expiry = block.timestamp + 1 days;
        (v, r, s) = vm.sign(ALICE_KEY, _delegationDigest(alice, nonce, expiry));
        vm.expectRevert(SignalVotes.InvalidNonce.selector);
        token.delegateBySig(alice, nonce, expiry, v, r, s);
    }

    function test_wrapperDepositWithdrawKeepsSupplyAndCheckpoints() public {
        MockERC20 underlying = new MockERC20();
        SignalVotesWrapper wrapped = new SignalVotesWrapper("Wrapped", "wMCK", ISignalUnderlying(address(underlying)));
        underlying.mint(alice, 80 ether);
        vm.roll(5);
        vm.startPrank(alice);
        underlying.approve(address(wrapped), 80 ether);
        wrapped.depositFor(alice, 80 ether);
        assertEq(wrapped.balanceOf(alice), 80 ether);
        assertEq(underlying.balanceOf(address(wrapped)), 80 ether);
        assertEq(wrapped.getVotes(alice), 0);
        wrapped.delegate(alice);
        assertEq(wrapped.getVotes(alice), 80 ether);
        vm.roll(6);
        wrapped.withdrawTo(bob, 30 ether);
        vm.stopPrank();
        assertEq(wrapped.balanceOf(alice), 50 ether);
        assertEq(wrapped.balanceOf(bob), 0);
        assertEq(underlying.balanceOf(bob), 30 ether);
        assertEq(wrapped.totalSupply(), 50 ether);
        assertEq(wrapped.getVotes(alice), 50 ether);
        vm.roll(7);
        assertEq(wrapped.getPastVotes(alice, 5), 80 ether);
        assertEq(wrapped.getPastTotalSupply(5), 80 ether);
    }

    function testFuzz_delegatedVotesMatchDelegatedBalances(uint96 sendRaw, uint8 mode) public {
        uint256 send = bound(uint256(sendRaw), 0, token.balanceOf(alice));
        vm.prank(alice);
        token.delegate(alice);
        if (send > 0) {
            vm.prank(alice);
            token.transfer(bob, send);
        }
        uint8 pick = mode % 3;
        if (pick == 1) {
            vm.prank(bob);
            token.delegate(bob);
        } else if (pick == 2 && send > 0) {
            vm.prank(bob);
            token.delegate(cara);
        }
        assertEq(_sumVotes(), _delegatedBalances());
        assertLe(_sumVotes(), token.totalSupply());
    }

    function _sumVotes() internal view returns (uint256) {
        return token.getVotes(alice) + token.getVotes(bob) + token.getVotes(cara);
    }

    function _delegatedBalances() internal view returns (uint256) {
        uint256 sum;
        if (token.delegates(alice) != address(0)) sum += token.balanceOf(alice);
        if (token.delegates(bob) != address(0)) sum += token.balanceOf(bob);
        if (token.delegates(cara) != address(0)) sum += token.balanceOf(cara);
        return sum;
    }

    function _delegationDigest(address delegatee, uint256 nonce, uint256 expiry) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"), delegatee, nonce, expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _permitDigest(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }
}
