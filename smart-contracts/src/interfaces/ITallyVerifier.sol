// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface ITallyVerifier {
    error ZeroAddress();
    error UnknownElection();
    error NotTallyOperator();
    error ElectionNotClosed();
    error AlreadyTallied();
    error EmptyCounts();
    error CountMismatch();
    error InvalidProof();
    error AggregateRequired();
    error AggregateHashRequired();
    error NotAggregateScheme();
    error NotSuperAdmin();
    error TallyVerifierNotSet();
    error TallyVerifierAlreadySet();
    error MockVerifierNotAllowed();
    error ContractPaused();
    error ReentrantCall();
    error CountsTooLong();
    /// @notice VOTE elections reject result publication before `cutoffTime`.
    error ResultsSealedUntilEnd(uint256 electionId);
    /// @notice Neither kind accepts another tally component at or after cutoff.
    error TallyComponentsClosed(uint256 electionId);
    error EmptyCommitment();
    error TooManyTallyComponents();
    /// @notice This field already received its one write at or after cutoff.
    error ResultAlreadyFinal(uint256 electionId);
    /// @notice The one post-cutoff interim or disclosure write needs a posted tally.
    error FinalBeforeTally(uint256 electionId);
    /// @notice Aggregate decryption is accepted only after a tally is posted.
    error DecryptionBeforeTally(uint256 electionId);
    /// @notice `tallyComponentAt` index is past the stored list.
    error TallyComponentOutOfRange(uint256 index);
    /// @notice `block.timestamp` is still before `cutoffTime + challengeWindow`.
    error ChallengeWindowOpen(uint256 electionId);
    error ZeroChallengeWindow();
    error ChallengeWindowTooShort();
    error LinksLocked();
    error ChallengeWindowLocked(uint256 electionId);
    error ChallengeWindowAlreadySet(uint256 electionId);
    /// @notice Tally, decryption, and final partials wait for the supplementary batch.
    error SupplementaryBatchRequired(uint256 electionId);
    error SettlementAlreadySet();
    error CeremonyAlreadySet();
    error InvalidPartial();
    error PartialAlreadyPosted();
    error NotGuardian();
    error NotEnoughPartials(uint256 electionId);
    error FinalPartialTooEarly(uint256 electionId);
    error NotPoll();
    error HourNotPosted();
    error HourGateClosed();
    error CiphertextMissing();
    error PlaintextMismatch();
    error NotElectionFactory();
    error KeyNotPosted();

    event TallyPosted(uint256 indexed electionId, bytes32 countsHash, uint256 total);
    /// @notice Aggregate result. `aggregateHash` commits to the summed ciphertext,
    ///         not to a per-ballot opening list.
    event AggregateTallyPosted(
        uint256 indexed electionId, bytes32 countsHash, bytes32 aggregateHash, bytes32 ballotRoot, uint256 total
    );
    event TallyProofVerifierSet(address indexed verifier);
    /// @notice One hash of the decrypted aggregate. Not a per-ballot opening.
    event AggregateDecrypted(uint256 indexed electionId, bytes32 aggregatePlaintextHash);
    event InterimResultPosted(uint256 indexed electionId, bytes32 resultHash);
    event DisclosurePosted(uint256 indexed electionId, bytes32 disclosureHash);
    /// @notice Hash contribution to a running tally. Not a ballot and not an opening.
    event TallyComponentAdded(uint256 indexed electionId, uint256 index, bytes32 componentHash);

    /// @notice Factory that maps `electionId` → Election clone.
    function factory() external view returns (address);

    /// @notice Groth16 verifier for the `TallyPublicInputs` instance. Set once.
    function tallyProofVerifier() external view returns (address);

    /// @notice Largest option vector `submitTally` / `submitAggregateTally` accepts.
    function MAX_TALLY_OPTIONS() external view returns (uint256);

    function setTallyProofVerifier(address verifier_) external;

    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    /// @notice Aggregate path: `counts` is the option histogram and `aggregateHash`
    ///         binds the homomorphic product. There is no per-ballot openings array.
    function submitAggregateTally(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function tally(uint256 electionId) external view returns (uint256[] memory);

    function isTallied(uint256 electionId) external view returns (bool);

    function aggregateHash(uint256 electionId) external view returns (bytes32);

    function postedScheme(uint256 electionId) external view returns (uint8);

    /// @notice Record a hash of the decrypted aggregate. No per-ballot plaintext.
    ///         Requires a posted tally. Before cutoff, VOTE reverts `ResultsSealedUntilEnd`
    ///         and POLL reverts `ChallengeWindowOpen`. After the window the hash is write-once.
    /// @notice `subset` is the 1-based guardian indexes that open the ciphertext.
    ///         Legacy elections (no ceremony and no settlement) ignore it.
    function submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash, uint8[] calldata subset) external;

    /// @notice Running result commitment. POLL may replace it before cutoff. VOTE may not
    ///         post before cutoff. At or after cutoff it may be written once, even if a
    ///         pre-cutoff interim is already stored, and only after a tally is posted
    ///         (`FinalBeforeTally`). That write is the certified final value. A second
    ///         post-cutoff write reverts `ResultAlreadyFinal`.
    function postInterimResult(uint256 electionId, bytes32 resultHash) external;

    /// @notice Result disclosure commitment. Same clock as `postInterimResult`:
    ///         replaceable before cutoff for a POLL, one write at or after cutoff,
    ///         and only after a tally is posted.
    function disclose(uint256 electionId, bytes32 disclosureHash_) external;

    /// @notice Append one tally component while the window is open.
    ///         Refused after cutoff for both kinds. VOTE is also sealed before cutoff.
    function addTallyComponent(uint256 electionId, bytes32 componentHash) external;

    function decryptionHash(uint256 electionId) external view returns (bytes32);

    function interimResult(uint256 electionId) external view returns (bytes32);

    function disclosureHash(uint256 electionId) external view returns (bytes32);

    function tallyComponentCount(uint256 electionId) external view returns (uint256);

    function tallyComponentAt(uint256 electionId, uint256 index) external view returns (bytes32);

    function setChallengeWindow(uint256 electionId, uint64 secondsAfterCutoff) external;

    function challengeWindow(uint256 electionId) external view returns (uint64);

    function tallyAllowedAt(uint256 electionId) external view returns (uint256);

    /// @notice Smallest window `createElection` arms. A stored zero is refused.
    function MIN_CHALLENGE_WINDOW() external view returns (uint256);

    /// @notice Factory only. Stores `MIN_CHALLENGE_WINDOW` when the slot is still zero.
    ///         Does not consume the operator's one custom write.
    function armChallengeWindow(uint256 electionId) external;

    function setRollupSettlement(uint256 electionId, address settlement_) external;

    function settlementOf(uint256 electionId) external view returns (address);

    function setCeremony(uint256 electionId, address ceremony_) external;

    function ceremonyOf(uint256 electionId) external view returns (address);

    /// @notice POLL only, for a posted hour, after the 100-ballot-or-end gate plus 30 minutes.
    ///         `c1` is the stored hourly ciphertext, not a caller argument.
    function submitHourlyPartial(
        uint256 electionId,
        uint256 hourIndex,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z
    ) external;

    function hourlyPartialPosted(uint256 electionId, uint256 hourIndex, address guardian) external view returns (bool);

    /// @notice Partial of one stored option ciphertext. `c1` is not a caller argument.
    ///         Option 0 is the batch ciphertext. Later options are the batch's option list.
    function submitFinalPartial(
        uint256 electionId,
        uint8 option,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z
    ) external;

    function optionPartialPosted(uint256 electionId, uint8 option, address guardian) external view returns (bool);

    function finalPartialCount(uint256 electionId) external view returns (uint256);
}
