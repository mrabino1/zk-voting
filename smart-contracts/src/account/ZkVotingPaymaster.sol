// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingPaymaster, UserOp} from "./ZkVotingEntryPoint.sol";

/// @title ZkVotingPaymaster
/// @notice Civic gas sponsor. Voters do not hold an L2 gas token and are
///         never charged. The jurisdiction funds this contract at cost.
///         There is no fee, no markup, and no admin skimming of voter funds.
contract ZkVotingPaymaster is IZkVotingPaymaster {
    error ZeroAddress();
    error NotEntryPoint();
    error NotAdmin();
    error NotSponsored();
    error WithdrawFailed();

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SponsoredTargetsUpdated(address ballotInbox, address voterRegistry, address accountFactory);
    event AlwaysSponsorSet(bool alwaysSponsor);

    address public immutable entryPoint;
    address public immutable admin;

    /// @notice When true (default), every UserOp through this paymaster is
    ///         sponsored. ZK-Voting L2 is gasless for voters by policy.
    /// @notice Audit M-08: off by default. Deployments sponsor only the civic
    ///         targets (inbox, voter registry, account factory) unless an
    ///         admin opts into blanket sponsorship.
    bool public alwaysSponsor;

    /// @dev `execute(address,uint256,bytes)` on PasskeyAccount.
    bytes4 internal constant EXECUTE_SELECTOR = bytes4(keccak256("execute(address,uint256,bytes)"));

    address public ballotInbox;
    address public voterRegistry;
    address public accountFactory;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    constructor(address entryPoint_, address admin_) {
        if (entryPoint_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        admin = admin_;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Jurisdiction / sequencer funds gas sponsorship. No voter payment.
    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Admin (jurisdiction treasury) may withdraw unused sponsorship ETH.
    ///         Never called against a voter; voters are not charged.
    function withdraw(address payable to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    function setAlwaysSponsor(bool alwaysSponsor_) external onlyAdmin {
        alwaysSponsor = alwaysSponsor_;
        emit AlwaysSponsorSet(alwaysSponsor_);
    }

    function setSponsoredTargets(address ballotInbox_, address voterRegistry_, address accountFactory_)
        external
        onlyAdmin
    {
        ballotInbox = ballotInbox_;
        voterRegistry = voterRegistry_;
        accountFactory = accountFactory_;
        emit SponsoredTargetsUpdated(ballotInbox_, voterRegistry_, accountFactory_);
    }

    /// @notice Called by the EntryPoint. Returns true if this UserOp is civic-sponsored.
    /// @dev Always true when `alwaysSponsor`. Otherwise the execute target (or
    ///      initCode factory) must be BallotInbox, VoterRegistry, or PasskeyAccountFactory.
    ///      No fees are charged to the voter in any path.
    function validateAndPay(UserOp calldata op) external view onlyEntryPoint returns (bool) {
        if (alwaysSponsor) return true;
        if (_isSponsored(op)) return true;
        revert NotSponsored();
    }

    /// @dev Audit M-08: a factory `initCode` no longer sponsors whatever
    ///      `callData` rides along; the call itself must be a zero-value
    ///      `execute` into a civic target (or empty, deploy-only).
    function _isSponsored(UserOp calldata op) internal view returns (bool) {
        if (op.initCode.length >= 20) {
            address factory = address(bytes20(op.initCode[:20]));
            if (accountFactory == address(0) || factory != accountFactory) return false;
            if (op.callData.length == 0) return true;
        }

        if (op.callData.length < 68) return false;
        if (bytes4(op.callData[:4]) != EXECUTE_SELECTOR) return false;
        if (uint256(bytes32(op.callData[36:68])) != 0) return false;
        address dest = _executeDest(op.callData);
        if (dest == address(0)) return false;
        if (ballotInbox != address(0) && dest == ballotInbox) return true;
        if (voterRegistry != address(0) && dest == voterRegistry) return true;
        if (accountFactory != address(0) && dest == accountFactory) return true;
        return false;
    }

    /// @dev First ABI argument of `execute(address dest, uint256 value, bytes data)`.
    function _executeDest(bytes calldata callData) internal pure returns (address dest) {
        if (callData.length < 36) return address(0);
        dest = address(uint160(uint256(bytes32(callData[4:36]))));
    }
}
