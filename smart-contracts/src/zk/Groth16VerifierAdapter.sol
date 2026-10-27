// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IGroth16VerifierAdapter} from "../interfaces/IGroth16VerifierAdapter.sol";

/// @title Groth16VerifierAdapter
/// @notice Adapts a snarkjs-exported verifier (`uint[N] calldata` public inputs) to
///         `IGroth16Verifier` (`uint256[]`). Local proving-path only until a real VK
///         is compiled into `VoteVerifier`.
/// @dev The snarkjs Solidity file is **not** in git (`circuits/build/`). Deploy that
///      artifact, then this adapter. A zero verifying key in `VoteVerifier` is not a
///      ceremony. Adapter never short-circuits to true.
contract Groth16VerifierAdapter is IGroth16VerifierAdapter {
    address public immutable impl;
    uint256 public immutable publicInputCount;

    constructor(address impl_, uint256 publicInputCount_) {
        if (impl_ == address(0)) revert ZeroAddress();
        if (publicInputCount_ != 5) revert UnsupportedPublicInputCount();
        impl = impl_;
        publicInputCount = publicInputCount_;
    }

    /// @inheritdoc IGroth16Verifier
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata input
    ) external view returns (bool) {
        if (input.length != publicInputCount) return false;
        uint256[5] memory pub;
        pub[0] = input[0];
        pub[1] = input[1];
        pub[2] = input[2];
        pub[3] = input[3];
        pub[4] = input[4];
        (bool ok, bytes memory ret) = impl.staticcall(
            abi.encodeWithSignature("verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[5])", a, b, c, pub)
        );
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }
}
