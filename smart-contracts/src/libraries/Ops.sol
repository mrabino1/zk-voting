// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title Ops
/// @notice L2 operation types and their pubdata layout. See `docs/ROLLUP.md`.
/// @dev Pubdata is the big-endian concatenation of operations. A priority operation has a
///      request part, which must hash to the queued request, and a response part written by the
///      operator and constrained by the batch proof. Sizes are in bytes.
library Ops {
    uint8 internal constant CREATE_ELECTION = 0x01;
    uint8 internal constant REGISTER = 0x02;
    uint8 internal constant DISQUALIFY = 0x03;
    uint8 internal constant BALLOT = 0x04;
    uint8 internal constant FORCED_BALLOT = 0x05;
    uint8 internal constant CLOSE = 0x06;

    /// @dev type·1 id·4 configHash·32 start·8 cutoff·8 options·1 jointX·32 jointY·32
    uint256 internal constant CREATE_ELECTION_BYTES = 118;
    /// @dev type·1 id·4 count·1, then count commitments of 32 bytes.
    uint256 internal constant REGISTER_HEADER_BYTES = 6;
    uint256 internal constant MAX_REGISTER_PER_OP = 32;
    /// @dev type·1 id·4 commitment·32 reason·2
    uint256 internal constant DISQUALIFY_BYTES = 39;
    /// @dev type·1 id·4 nullifier·32 ballotCommitment·32
    uint256 internal constant BALLOT_BYTES = 69;
    /// @dev type·1 id·4 nullifier·32 ballotCommitment·32 payloadHash·32, then accepted·1.
    uint256 internal constant FORCED_BALLOT_REQUEST_BYTES = 101;
    uint256 internal constant FORCED_BALLOT_BYTES = 102;
    /// @dev type·1 id·4, then ballots·4 options·1 and 128 bytes per option.
    uint256 internal constant CLOSE_REQUEST_BYTES = 5;
    uint256 internal constant CLOSE_RESPONSE_HEADER_BYTES = 5;
    uint256 internal constant CIPHERTEXT_BYTES = 128;

    error MalformedPubdata();

    /// @notice Length of the operation that starts at `offset`, and the length of its
    ///         request part (zero for an L2 operation).
    function sizeAt(bytes calldata pubdata, uint256 offset)
        internal
        pure
        returns (uint8 opType, uint256 size, uint256 requestSize)
    {
        if (offset >= pubdata.length) revert MalformedPubdata();
        opType = uint8(pubdata[offset]);
        if (opType == CREATE_ELECTION) {
            size = requestSize = CREATE_ELECTION_BYTES;
        } else if (opType == REGISTER) {
            if (offset + REGISTER_HEADER_BYTES > pubdata.length) revert MalformedPubdata();
            uint256 count = uint8(pubdata[offset + 5]);
            if (count == 0 || count > MAX_REGISTER_PER_OP) revert MalformedPubdata();
            size = requestSize = REGISTER_HEADER_BYTES + 32 * count;
        } else if (opType == DISQUALIFY) {
            size = requestSize = DISQUALIFY_BYTES;
        } else if (opType == BALLOT) {
            size = BALLOT_BYTES;
        } else if (opType == FORCED_BALLOT) {
            size = FORCED_BALLOT_BYTES;
            requestSize = FORCED_BALLOT_REQUEST_BYTES;
        } else if (opType == CLOSE) {
            uint256 header = CLOSE_REQUEST_BYTES + CLOSE_RESPONSE_HEADER_BYTES;
            if (offset + header > pubdata.length) revert MalformedPubdata();
            uint256 options = uint8(pubdata[offset + header - 1]);
            size = header + CIPHERTEXT_BYTES * options;
            requestSize = CLOSE_REQUEST_BYTES;
        } else {
            revert MalformedPubdata();
        }
        if (offset + size > pubdata.length) revert MalformedPubdata();
    }

    function electionIdAt(bytes calldata data, uint256 offset) internal pure returns (uint32) {
        return uint32(bytes4(data[offset + 1:offset + 5]));
    }

    function wordAt(bytes calldata data, uint256 offset) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := calldataload(add(data.offset, offset))
        }
    }

    function encodeCreateElection(
        uint32 electionId,
        bytes32 configHash,
        uint64 startTime,
        uint64 cutoffTime,
        uint8 optionCount,
        uint256 jointX,
        uint256 jointY
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            CREATE_ELECTION, electionId, configHash, startTime, cutoffTime, optionCount, jointX, jointY
        );
    }

    function encodeRegister(uint32 electionId, uint256[] calldata commitments, uint256 from, uint256 count)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(REGISTER, electionId, uint8(count));
        for (uint256 i; i < count; ++i) {
            out = bytes.concat(out, bytes32(commitments[from + i]));
        }
    }

    function encodeDisqualify(uint32 electionId, uint256 commitment, uint16 reasonCode)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(DISQUALIFY, electionId, commitment, reasonCode);
    }

    function encodeForcedBallot(uint32 electionId, uint256 nullifier, uint256 ballotCommitment, bytes32 payloadHash)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(FORCED_BALLOT, electionId, nullifier, ballotCommitment, payloadHash);
    }

    function encodeClose(uint32 electionId) internal pure returns (bytes memory) {
        return abi.encodePacked(CLOSE, electionId);
    }
}
