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
    /// @notice The stored hash is final at or after cutoff and cannot be replaced.
    error ResultAlreadyFinal(uint256 electionId);
    /// @notice Aggregate decryption is accepted only after a tally is posted.
    error DecryptionBeforeTally(uint256 electionId);
    /// @notice `tallyComponentAt` index is past the stored list.
    error TallyComponentOutOfRange(uint256 index);
    /// @notice VOTE results are posted on the sealed tally, not this contract.
    error SealedVoteUsesOtherTally(uint256 electionId);

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
    ///         and POLL reverts `ElectionNotClosed`. After cutoff the hash is write-once.
    function submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash) external;

    /// @notice Running result commitment. POLL may replace it before cutoff. VOTE may not
    ///         post before cutoff. At or after cutoff the stored hash is write-once.
    function postInterimResult(uint256 electionId, bytes32 resultHash) external;

    /// @notice Result disclosure commitment. POLL may replace it before cutoff. VOTE may not
    ///         post before cutoff. At or after cutoff the stored hash is write-once.
    function disclose(uint256 electionId, bytes32 disclosureHash_) external;

    /// @notice Append one tally component while the window is open.
    ///         Refused after cutoff for both kinds. VOTE is also sealed before cutoff.
    function addTallyComponent(uint256 electionId, bytes32 componentHash) external;

    function decryptionHash(uint256 electionId) external view returns (bytes32);

    function interimResult(uint256 electionId) external view returns (bytes32);

    function disclosureHash(uint256 electionId) external view returns (bytes32);

    function tallyComponentCount(uint256 electionId) external view returns (uint256);

    function tallyComponentAt(uint256 electionId, uint256 index) external view returns (bytes32);
}
