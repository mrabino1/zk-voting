// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @notice Shared election configuration. `maxParticipants == 0` means unlimited.
struct ElectionParams {
    string title;
    string metadataURI;
    uint64 startTime;
    uint64 cutoffTime;
    uint32 maxParticipants;
    uint8 treeDepth;
    bytes32 ballotSpecHash;
    address clerk;
    address registrar;
    address disqualificationOfficer;
    address tallyOperator;
    address verifier;
    uint8 questionCount;
    bytes32 jurisdictionId;
    /// @notice P-256 tally encryption pubkey X. Zero with `tallyScheme == 0` keeps legacy sum-only demo mode.
    bytes32 tallyPubKeyX;
    /// @notice P-256 tally encryption pubkey Y.
    bytes32 tallyPubKeyY;
    /// @notice 0 = SUM_ONLY (any `counts` that sum to acceptedBallots).
    ///         1 = AGGREGATE (one aggregate ciphertext hash; no per-ballot openings).
    uint8 tallyScheme;
}

/// @notice Tally binding mode. Additive: existing elections default to SUM_ONLY (0).
library TallyScheme {
    uint8 internal constant SUM_ONLY = 0;
    /// @notice Counts plus one aggregate hash. Individual ballot openings are not an input.
    uint8 internal constant AGGREGATE = 1;
    /// @dev Historical name for `AGGREGATE`. Per-ballot openings are no longer accepted.
    uint8 internal constant OPENS_BALLOTS = 1;
}

library ElectionState {
    uint8 internal constant CREATED = 0;
    uint8 internal constant ROLL_FROZEN = 1;
    uint8 internal constant OPEN = 2;
    uint8 internal constant CLOSED = 3;
    uint8 internal constant TALLIED = 4;
}
