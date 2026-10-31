// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/// @title PlaceholderAggregateVerifier
/// @notice PLACEHOLDER. Not a production verifier and not a proof system.
/// @dev This contract does not verify a ZK proof. It fails closed: `verifyProof`
///      returns false unless `testMode` was set at construction. Test mode
///      accepts only the commitment of the public inputs, so a proof minted for
///      another statement, including a reused or swapped chunk statement, returns
///      false. Do not deploy this on a production settlement. A real aggregate
///      verifier for the batch statement is still required.
contract PlaceholderAggregateVerifier is IGroth16Verifier {
    /// @notice When false, every proof is rejected.
    bool public immutable testMode;

    constructor(bool testMode_) {
        testMode = testMode_;
    }

    /// @notice Reported so a deployment that refuses stand-in verifiers can reject this contract.
    function isMock() external pure returns (bool) {
        return true;
    }

    /// @notice This stand-in does not prove the tally. Settlement keeps the on-chain
    ///         ciphertext sum until a verifier reports `true` here.
    function verifiesTally() external pure virtual returns (bool) {
        return false;
    }

    /// @notice Commitment a test uses as `(a, b, c)` for `input`. Not a proof.
    function commitmentOf(uint256[] memory input)
        public
        pure
        returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c)
    {
        uint256 digest = uint256(keccak256(abi.encode(input)));
        a[0] = digest;
        a[1] = digest;
        b[0][0] = digest;
        b[0][1] = digest;
        b[1][0] = digest;
        b[1][1] = digest;
        c[0] = digest;
        c[1] = digest;
    }

    /// @inheritdoc IGroth16Verifier
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata input
    ) external view returns (bool) {
        if (!testMode) return false;
        (uint256[2] memory ea, uint256[2][2] memory eb, uint256[2] memory ec) = commitmentOf(input);
        return a[0] == ea[0] && a[1] == ea[1] && b[0][0] == eb[0][0] && b[0][1] == eb[0][1] && b[1][0] == eb[1][0]
            && b[1][1] == eb[1][1] && c[0] == ec[0] && c[1] == ec[1];
    }
}
