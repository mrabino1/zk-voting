// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title UserOp
/// @notice ERC-4337-lite UserOperation. Not the full eth-infinitism layout:
///         no `preVerificationGas`, no `maxPriorityFeePerGas`, no paymaster
///         gas limits. Gas is civic-sponsored; there is no gas token.
struct UserOp {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 maxFeePerGas;
    address paymaster;
    bytes paymasterAndData;
    bytes signature;
}

interface IRepublicAccount {
    function validateUserOp(UserOp calldata op, bytes32 userOpHash) external returns (bool);

    function execute(address dest, uint256 value, bytes calldata data) external;

    function nonce() external view returns (uint256);
}

interface IRepublicPaymaster {
    function validateAndPay(UserOp calldata op) external returns (bool);
}

/// @title RepublicEntryPoint
/// @notice Minimal bundler entry point for local Republic L2.
///         Validate nonce → account.validateUserOp → optional paymaster → execute.
///         Keep small and auditable. Not a fork of eth-infinitism EntryPoint.
contract RepublicEntryPoint {
    error InvalidInitCode();
    error DeployFailed();
    error SenderMismatch();
    error AccountNotDeployed();
    error InvalidNonce();
    error ValidationFailed();
    error PaymasterRejected();
    error ExecuteFailed();

    event UserOpHandled(address indexed sender, uint256 nonce, address paymaster);

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

    /// @notice Bundler entry: process a batch. First failure reverts the batch.
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

        if (IRepublicAccount(op.sender).nonce() != op.nonce) revert InvalidNonce();

        bytes32 userOpHash = getUserOpHash(op);
        bool valid = IRepublicAccount(op.sender).validateUserOp(op, userOpHash);
        if (!valid) revert ValidationFailed();

        if (op.paymaster != address(0)) {
            bool paid = IRepublicPaymaster(op.paymaster).validateAndPay(op);
            if (!paid) revert PaymasterRejected();
        }

        _execute(op.sender, op.callGasLimit, op.callData);
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
    function _execute(address sender, uint256 gasLimit, bytes calldata data) internal {
        if (data.length == 0) return;
        bool ok;
        bytes memory ret;
        if (gasLimit == 0) {
            (ok, ret) = sender.call(data);
        } else {
            (ok, ret) = sender.call{gas: gasLimit}(data);
        }
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert ExecuteFailed();
        }
    }
}
