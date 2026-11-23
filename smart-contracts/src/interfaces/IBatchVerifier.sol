// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @notice Validity-proof verifier for one L2 batch. The single public input is the batch
///         commitment computed by `ZkVotingRollup.commitBatch`.
interface IBatchVerifier {
    /// @param proof Groth16 `(a.x, a.y, b.x1, b.x0, b.y1, b.y0, c.x, c.y)`.
    function verifyProof(uint256[8] calldata proof, uint256 commitment) external view returns (bool);

    /// @notice True for a verifier that accepts proofs it did not check.
    function isMock() external view returns (bool);
}
