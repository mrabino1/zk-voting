// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

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
