// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title RepublicMailbox
/// @notice L2 ↔ L1 messages and a sequencer-stall force-inclusion hatch.
///         Price is ZERO. Not for profit. No fee on sendToL2.
contract RepublicMailbox {
    error ZeroAddress();
    error NotAdmin();
    error NotReady();
    error EmptyMessage();

    event MessageToL2(uint256 indexed nonce, address indexed sender, bytes message);
    event MessageToL1(uint256 indexed nonce, address indexed sender, bytes message);
    event Enqueued(uint256 indexed nonce, address indexed sender, uint256 readyAt, bytes message);
    event ForceIncluded(uint256 indexed nonce, address indexed includer);

    uint256 public immutable inclusionDelay;
    address public admin;
    uint256 public toL2Nonce;
    uint256 public toL1Nonce;
    uint256 public queueNonce;

    struct Pending {
        address sender;
        uint256 readyAt;
        bytes message;
        bool included;
    }

    mapping(uint256 => Pending) public queue;

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        inclusionDelay = 1 days;
    }

    function sendToL2(bytes calldata message) external payable {
        if (message.length == 0) revert EmptyMessage();
        uint256 n = ++toL2Nonce;
        emit MessageToL2(n, msg.sender, message);
    }

    function sendToL1(bytes calldata message) external {
        if (message.length == 0) revert EmptyMessage();
        uint256 n = ++toL1Nonce;
        emit MessageToL1(n, msg.sender, message);
    }

    function enqueue(bytes calldata message) external {
        if (message.length == 0) revert EmptyMessage();
        uint256 n = ++queueNonce;
        queue[n] = Pending({sender: msg.sender, readyAt: block.timestamp + inclusionDelay, message: message, included: false});
        emit Enqueued(n, msg.sender, block.timestamp + inclusionDelay, message);
    }

    function forceInclude(uint256 nonce) external {
        Pending storage p = queue[nonce];
        if (p.sender == address(0) || p.included) revert NotReady();
        if (block.timestamp < p.readyAt) revert NotReady();
        p.included = true;
        emit ForceIncluded(nonce, msg.sender);
        emit MessageToL2(nonce, p.sender, p.message);
    }
}
