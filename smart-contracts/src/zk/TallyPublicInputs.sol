// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

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
/// Solidity mock instance (`TALLY_SOL_MOCK_V1`, this library):
///   [0] TALLY_INSTANCE_VERSION (1)
///   [1] electionId
///   [2] acceptedCount
///   [3] countsHash     = keccak256(abi.encodePacked(counts))
///   [4] ballotRoot     = inbox hash-chain of accepted ballot hashes (0 if SUM_ONLY)
///   [5] openingsHash   = keccak256(abi.encodePacked(openings)) (0 if SUM_ONLY)
///
/// Circom fixes `nOptions` at compile time and exposes `counts[]` in the clear.
/// Solidity supports a variable-length vector via `countsHash`, plus the
/// opened-ballot bind (`ballotRoot`, `openingsHash`). A production verifier
/// generated from the circuit must not be wired to `Tally.sol` until a
/// translating wrapper exists. Local tests keep `MockVerifier`.
library TallyPublicInputs {
    uint256 internal constant VERSION = 1;

    function mockInstance(
        uint256 electionId,
        uint256 acceptedCount,
        bytes32 countsHash,
        bytes32 ballotRoot,
        bytes32 openingsHash
    ) internal pure returns (uint256[] memory input) {
        input = new uint256[](6);
        input[0] = VERSION;
        input[1] = electionId;
        input[2] = acceptedCount;
        input[3] = uint256(countsHash);
        input[4] = uint256(ballotRoot);
        input[5] = uint256(openingsHash);
    }

    function countsHashOf(uint256[] memory counts) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(counts));
    }

    function openingsHashOf(uint256[] calldata openings) internal pure returns (bytes32) {
        if (openings.length == 0) return bytes32(0);
        return keccak256(abi.encodePacked(openings));
    }
}
