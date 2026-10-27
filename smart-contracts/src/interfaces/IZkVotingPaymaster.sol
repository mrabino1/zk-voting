// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {UserOp} from "./UserOp.sol";

interface IZkVotingPaymaster {
    error ZeroAddress();
    error NotEntryPoint();
    error NotAdmin();
    error NotSponsored();
    error WithdrawFailed();
    error ReentrantCall();

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SponsoredTargetsUpdated(address ballotInbox, address voterRegistry, address accountFactory);
    event AlwaysSponsorSet(bool alwaysSponsor);

    function entryPoint() external view returns (address);

    function admin() external view returns (address);

    function alwaysSponsor() external view returns (bool);

    function ballotInbox() external view returns (address);

    function voterRegistry() external view returns (address);

    function accountFactory() external view returns (address);

    function deposit() external payable;

    function withdraw(address payable to, uint256 amount) external;

    function setAlwaysSponsor(bool alwaysSponsor_) external;

    function setSponsoredTargets(address ballotInbox_, address voterRegistry_, address accountFactory_) external;

    /// @notice Called by the EntryPoint. Returns true if this UserOp is civic-sponsored.
    /// @dev View: sponsorship is a check, not a debit. The EntryPoint staticcalls it.
    function validateAndPay(UserOp calldata op) external view returns (bool);
}
