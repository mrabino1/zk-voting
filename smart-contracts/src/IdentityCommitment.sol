// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title IdentityCommitment
/// @notice keccak stand-in for Poseidon(trapdoor, nullifierSecret).
/// @dev Production circuits MUST use Poseidon. This keccak helper is only the
///      EVM-test leaf formula. The leaf is NEVER a wallet address.
library IdentityCommitment {
    function toLeaf(uint256 trapdoor, uint256 nullifierSecret) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(trapdoor, nullifierSecret)));
    }

    function nullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(nullifierSecret, electionId)));
    }
}
