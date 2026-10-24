// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title ElectionIdentity
/// @notice Canonical L1 slot for an election. A public UUID is never this key.
/// @dev Two jurisdictions (or a honest body and a forked Node) can advertise
///      the same UUID. Courts separate them with
///      `keccak256(abi.encode(DOMAIN, factory, electionId, jurisdictionId))`.
///      The factory uint256 is unique *per factory*; the UUID is a Node alias.
library ElectionIdentity {
    /// @dev keccak256("zk-voting.election.identity.v1")
    bytes32 internal constant DOMAIN = keccak256("zk-voting.election.identity.v1");

    function certificationId(address factory, uint256 electionId, bytes32 jurisdictionId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN, factory, electionId, jurisdictionId));
    }

    /// @notice Commitment to the advertised public id (ASCII-lowercased UUID).
    function publicIdHash(string memory uuid) internal pure returns (bytes32) {
        bytes memory b = bytes(uuid);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) b[i] = bytes1(c + 32);
        }
        return keccak256(b);
    }
}
