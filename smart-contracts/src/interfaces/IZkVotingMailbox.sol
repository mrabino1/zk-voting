// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IZkVotingMailbox {
    error ZeroAddress();
    error NotAdmin();
    error NotReady();
    error EmptyMessage();

    event MessageToL2(uint256 indexed nonce, address indexed sender, bytes message);
    event MessageToL1(uint256 indexed nonce, address indexed sender, bytes message);
    event Enqueued(uint256 indexed nonce, address indexed sender, uint256 readyAt, bytes message);
    event ForceIncluded(uint256 indexed nonce, address indexed includer);

    function inclusionDelay() external view returns (uint256);

    function admin() external view returns (address);

    function toL2Nonce() external view returns (uint256);

    function toL1Nonce() external view returns (uint256);

    function queueNonce() external view returns (uint256);

    function queue(uint256 nonce)
        external
        view
        returns (address sender, uint256 readyAt, bytes memory message, bool included);

    function sendToL2(bytes calldata message) external;

    function sendToL1(bytes calldata message) external;

    function enqueue(bytes calldata message) external;

    /// @notice ADVISORY (audit L-07): this re-emits the queued message for the
    ///         sequencer / indexer. Settlement does not yet enforce inclusion.
    function forceInclude(uint256 nonce) external;
}
