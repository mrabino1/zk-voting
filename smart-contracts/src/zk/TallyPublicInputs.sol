// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title TallyPublicInputs
/// @notice Versioned Groth16 instance for `Tally.sol`. This is **not** the same
///         encoding as `circuits/tally.circom` public signals.
///
/// Circom (`tally.circom` default `Tally(8, 4)`, outputs first):
///   [0] total
///   [1] electionId
///   [2..5] counts[0..3]
///   [6] acceptedCount
///
/// Solidity instance (`TALLY_SOL_V2`, this library). Every word is a BN254
/// scalar-field element: hash words are reduced `mod r` (audit H-01 / H-05).
///   [0] TALLY_INSTANCE_VERSION (2)
///   [1] electionId
///   [2] acceptedCount
///   [3] countsHash     = keccak256(abi.encode(counts))                 mod r
///   [4] ballotRoot     = inbox hash-chain of accepted ballot hashes     mod r
///                        (bound for BOTH schemes since V2)
///   [5] aggregateHash  = commitment to the summed ciphertext             mod r (0 if SUM_ONLY)
///                        Never a hash of per-ballot openings.
///   [6] tallyKeyHash   = keccak256(abi.encodePacked(tallyPubKeyX, Y))   mod r
///
/// V1 (`TALLY_SOL_MOCK_V1`, 6 words, raw keccak words, ballotRoot = 0 under
/// SUM_ONLY) is retired. Circom fixes `nOptions` at compile time and exposes
/// `counts[]` in the clear; Solidity supports a variable-length vector via
/// `countsHash`. Word 5 is an aggregate ciphertext commitment, not a list of
/// openings. A production tally verifier must be generated from a circuit
/// that exposes exactly this instance (or wrapped by a translating adapter)
/// and installed with `Tally.setTallyProofVerifier`.
library TallyPublicInputs {
    uint256 internal constant VERSION = 2;
    uint256 internal constant WORDS = 7;

    /// @notice BN254 scalar field modulus r.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function instance(
        uint256 electionId,
        uint256 acceptedCount,
        bytes32 countsHash,
        bytes32 ballotRoot,
        bytes32 aggregateHash,
        bytes32 tallyKeyHash
    ) internal pure returns (uint256[] memory input) {
        input = new uint256[](WORDS);
        input[0] = VERSION;
        input[1] = electionId % SNARK_SCALAR_FIELD;
        input[2] = acceptedCount % SNARK_SCALAR_FIELD;
        input[3] = uint256(countsHash) % SNARK_SCALAR_FIELD;
        input[4] = uint256(ballotRoot) % SNARK_SCALAR_FIELD;
        input[5] = uint256(aggregateHash) % SNARK_SCALAR_FIELD;
        input[6] = uint256(tallyKeyHash) % SNARK_SCALAR_FIELD;
    }

    function countsHashOf(uint256[] memory counts) internal pure returns (bytes32) {
        return keccak256(abi.encode(counts));
    }

    function tallyKeyHashOf(bytes32 pubX, bytes32 pubY) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(pubX, pubY));
    }
}
