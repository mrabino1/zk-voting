// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {UserOp} from "./UserOp.sol";

interface IZkVotingEntryPoint {
    error InvalidInitCode();
    error DeployFailed();
    error SenderMismatch();
    error AccountNotDeployed();
    error InvalidNonce();
    error ValidationFailed();
    error PaymasterRejected();
    error ReentrantCall();

    event UserOpHandled(address indexed sender, uint256 nonce, address paymaster);
    /// @notice Audit M-08: an op whose execution reverted. Validation already
    ///         passed (nonce consumed), so the batch continues. `revertReason`
    ///         is truncated to `MAX_RETURN_BYTES`.
    event UserOpReverted(address indexed sender, uint256 nonce, bytes revertReason);

    /// @notice Audit M-08: cap on copied returndata (return-bomb guard).
    function MAX_RETURN_BYTES() external view returns (uint256);

    /// @notice Pack a UserOp hash bound to this chain and this EntryPoint.
    function getUserOpHash(UserOp calldata op) external view returns (bytes32);

    /// @notice Bundler entry: process a batch.
    function handleOps(UserOp[] calldata ops) external;
}
