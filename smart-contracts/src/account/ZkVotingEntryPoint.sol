// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingAccount} from "../interfaces/IZkVotingAccount.sol";
import {IZkVotingEntryPoint} from "../interfaces/IZkVotingEntryPoint.sol";
import {IZkVotingPaymaster} from "../interfaces/IZkVotingPaymaster.sol";
import {UserOp} from "../interfaces/UserOp.sol";

/// @title ZkVotingEntryPoint
/// @notice Minimal bundler entry point for local ZK-Voting L2.
///         Validate nonce → account.validateUserOp → optional paymaster → execute.
///         Keep small and auditable. Not a fork of eth-infinitism EntryPoint.
contract ZkVotingEntryPoint is IZkVotingEntryPoint {
    /// @notice Audit M-08: cap on copied returndata (return-bomb guard).
    uint256 public constant MAX_RETURN_BYTES = 256;

    /// @notice Pack a UserOp hash bound to this chain and this EntryPoint.
    function getUserOpHash(UserOp calldata op) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.callGasLimit,
                op.verificationGasLimit,
                op.maxFeePerGas,
                op.paymaster,
                keccak256(op.paymasterAndData),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Bundler entry: process a batch.
    /// @dev Audit M-08: as in ERC-4337, a validation failure (deploy, nonce,
    ///      signature, paymaster) still reverts the batch — the bundler should
    ///      have simulated it — but an execution revert is isolated: it emits
    ///      `UserOpReverted` and the remaining ops still run.
    function handleOps(UserOp[] calldata ops) external {
        uint256 n = ops.length;
        for (uint256 i; i < n; ++i) {
            _handle(ops[i]);
        }
    }

    function _handle(UserOp calldata op) internal {
        if (op.sender.code.length == 0) {
            if (op.initCode.length == 0) revert AccountNotDeployed();
            _deploy(op.initCode, op.sender);
        }

        if (IZkVotingAccount(op.sender).nonce() != op.nonce) revert InvalidNonce();

        bytes32 userOpHash = getUserOpHash(op);
        bool valid = IZkVotingAccount(op.sender).validateUserOp(op, userOpHash);
        if (!valid) revert ValidationFailed();

        if (op.paymaster != address(0)) {
            bool paid = IZkVotingPaymaster(op.paymaster).validateAndPay(op);
            if (!paid) revert PaymasterRejected();
        }

        (bool ok, bytes memory reason) = _execute(op.sender, op.callGasLimit, op.callData);
        if (!ok) {
            emit UserOpReverted(op.sender, op.nonce, reason);
            return;
        }
        emit UserOpHandled(op.sender, op.nonce, op.paymaster);
    }

    function _deploy(bytes calldata initCode, address expected) internal {
        if (initCode.length < 20) revert InvalidInitCode();
        address factory = address(bytes20(initCode[:20]));
        bytes calldata data = initCode[20:];
        (bool ok, bytes memory ret) = factory.call(data);
        if (!ok || ret.length < 32) revert DeployFailed();
        address created = abi.decode(ret, (address));
        if (created != expected) revert SenderMismatch();
        if (expected.code.length == 0) revert DeployFailed();
    }

    /// @dev `callData` is the account's `execute(dest, value, data)` encoding
    ///      (or another only-EntryPoint method). Empty callData is a deploy-only op.
    ///      Audit M-08: low-level call that copies at most `MAX_RETURN_BYTES`
    ///      of returndata, so a hostile callee cannot return-bomb the bundler.
    ///      `gasLimit == 0` keeps the legacy "forward all gas" meaning; the
    ///      EIP-150 1/64 reserve is enough to log the failure.
    function _execute(address sender, uint256 gasLimit, bytes calldata data)
        internal
        returns (bool ok, bytes memory reason)
    {
        if (data.length == 0) return (true, reason);
        bytes memory payload = data;
        uint256 g = gasLimit == 0 ? gasleft() : gasLimit;
        uint256 cap = MAX_RETURN_BYTES;
        assembly {
            ok := call(g, sender, 0, add(payload, 32), mload(payload), 0, 0)
            let size := returndatasize()
            if gt(size, cap) { size := cap }
            reason := mload(0x40)
            mstore(reason, size)
            returndatacopy(add(reason, 32), 0, size)
            mstore(0x40, add(add(reason, 32), and(add(size, 31), not(31))))
        }
        if (ok) reason = "";
    }
}
