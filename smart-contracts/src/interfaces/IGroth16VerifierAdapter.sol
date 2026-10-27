// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "./IGroth16Verifier.sol";

/// @notice Adapts a snarkjs verifier (`uint256[5]` public inputs) to `IGroth16Verifier`.
interface IGroth16VerifierAdapter is IGroth16Verifier {
    /// @notice `impl` was the zero address.
    error ZeroAddress();

    /// @notice Adapter only supports the 5-word vote public-input layout.
    error UnsupportedPublicInputCount();

    /// @notice snarkjs verifier this adapter calls.
    function impl() external view returns (address);

    /// @notice Public-input count the inner verifier was built for.
    function publicInputCount() external view returns (uint256);
}
