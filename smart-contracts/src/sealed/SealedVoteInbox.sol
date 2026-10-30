// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, ElectionType} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";
import {IVoterRegistry} from "../interfaces/IVoterRegistry.sol";
import {CappedVerifierCall} from "../zk/CappedVerifierCall.sol";

/// @title SealedVoteInbox
/// @notice VOTE ballots only. The relayer holds every ballot off chain and
///         reveals the whole set at or after `cutoffTime`, in one or more
///         transactions. Nothing in this contract changes per ballot before then.
/// @dev Trust (see `docs/sealed-vote-hold.md`):
///      - The relayer sees every ciphertext, the count, and the arrival times
///        off chain. That view is not on this chain.
///      - The relayer can omit a ballot. A voter who holds a receipt signed by
///        an allowlisted relayer can `forceInclude` it after cutoff and before
///        the sealed tally is posted. Omission is detectable by comparing the
///        receipt to `nullifierUsed` after the reveal.
///      - A transaction sent before cutoff reverts and writes nothing. The
///        calldata of that transaction would still be public, so the relayer
///        must not send ballots early.
///      - Five public inputs, the same vote circuit, relayer-only reveal.
///        `forceInclude` is the voter's remedy and may be sent by anyone who
///        holds the relayer's signature.
contract SealedVoteInbox {
    uint256 public constant MAX_REVEAL_BATCH = 32;
    uint256 public constant MAX_BALLOT_BYTES = 32 * 1024;
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IElectionFactory public immutable factory;

    mapping(uint256 => mapping(uint256 => bool)) private _nullifierUsed;
    mapping(uint256 => uint256) private _acceptedBallots;
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHashOf;
    mapping(uint256 => bytes32[]) private _ballotHashList;
    mapping(uint256 => bytes32) private _ballotRoot;
    /// @notice Seconds after cutoff during which an omitted receipt can still land.
    mapping(uint256 => uint64) public challengeWindow;
    mapping(uint256 => bool) private _tallied;
    uint256 private _reentrancyLock;

    error UnknownElection();
    error NotVote();
    error NotTallyOperator();
    error NotRelayer();
    error TooEarly(uint256 electionId);
    error SetupClosed();
    error AlreadyTallied();
    error EmptyBallot();
    error BallotTooLarge();
    error InvalidPublicInputs();
    error InvalidNullifier();
    error NullifierUsed();
    error InvalidProof();
    error EligibleRootMismatch();
    error DisqualificationRootMismatch();
    error ElectionIdMismatch();
    error BallotHashMismatch();
    error EligibleRootPending();
    error RollNotFrozen();
    error ZeroVerifier();
    error EmptyBatch();
    error BatchTooLarge();
    error BatchLengthMismatch();
    error DuplicateNullifier();
    error BadSignature();
    error ContractPaused();
    error ReentrantCall();

    /// @notice Emitted only at or after cutoff. `count` is the new total.
    event SealedBallotsRevealed(uint256 indexed electionId, uint256 added, uint256 count);
    event ChallengeWindowSet(uint256 indexed electionId, uint64 secondsAfterCutoff);
    event SealedTallySet(uint256 indexed electionId, address tally);
    event SealedTallyMarked(uint256 indexed electionId);

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert ReentrantCall();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert UnknownElection();
        factory = IElectionFactory(factory_);
    }

    /// @notice One configuration write before the election starts. Not a ballot.
    function setChallengeWindow(uint256 electionId, uint64 secondsAfterCutoff) external {
        ElectionParams memory p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert SetupClosed();
        challengeWindow[electionId] = secondsAfterCutoff;
        emit ChallengeWindowSet(electionId, secondsAfterCutoff);
    }

    /// @notice First moment the sealed tally may freeze the set.
    function tallyAllowedAt(uint256 electionId) external view returns (uint256) {
        ElectionParams memory p = _voteParams(electionId);
        return uint256(p.cutoffTime) + uint256(challengeWindow[electionId]);
    }

    /// @notice Relayer posts ballots it held. Reverts before cutoff with no write
    ///         when called through the external wrapper below.
    function reveal(
        uint256 electionId,
        uint256[2][] calldata a,
        uint256[2][2][] calldata b,
        uint256[2][] calldata c,
        uint256[][] calldata publicInputs,
        bytes[] calldata encryptedBallots
    ) external {
        _requireCutoff(electionId);
        _reveal(electionId, a, b, c, publicInputs, encryptedBallots);
    }

    /// @notice Anyone may supply a ballot the relayer signed for and then omitted.
    ///         The signature is over the nullifier, the ballot hash, and the
    ///         ciphertext. It is not a voter identity.
    function forceInclude(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot,
        bytes calldata signature
    ) external {
        _requireCutoff(electionId);
        _forceInclude(electionId, a, b, c, publicInputs, encryptedBallot, signature);
    }

    mapping(uint256 => address) public sealedTally;

    /// @notice One write before start, naming the tally that may freeze this set.
    function setSealedTally(uint256 electionId, address tally) external {
        ElectionParams memory p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert SetupClosed();
        if (tally == address(0)) revert UnknownElection();
        sealedTally[electionId] = tally;
        emit SealedTallySet(electionId, tally);
    }

    /// @notice Freezes the set. Only the configured tally, and only at or after cutoff,
    ///         so a mis-set tally cannot close the inbox while voting is still open.
    function noteTallied(uint256 electionId) external {
        _requireCutoff(electionId);
        if (msg.sender != sealedTally[electionId]) revert NotTallyOperator();
        _tallied[electionId] = true;
        emit SealedTallyMarked(electionId);
    }

    function acceptedBallots(uint256 electionId) external view returns (uint256) {
        return _acceptedBallots[electionId];
    }

    function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32) {
        return _ballotHashOf[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    function ballotRoot(uint256 electionId) external view returns (bytes32) {
        return _ballotRoot[electionId];
    }

    function ballotHashAt(uint256 electionId, uint256 index) external view returns (bytes32) {
        return _ballotHashList[electionId][index];
    }

    function isTallied(uint256 electionId) external view returns (bool) {
        return _tallied[electionId];
    }

    /// @notice EIP-191 digest over the receipt body. Sign this value with raw
    ///         ECDSA (`ecrecover` of this digest). Do not prefix it a second time.
    ///         `nullifier` is `publicInputs[2] mod r`. `ballotHash` is `bytes32(publicInputs[3])`.
    function receiptHash(uint256 electionId, uint256 nullifier, bytes32 ballotHash, bytes calldata encryptedBallot)
        external
        view
        returns (bytes32)
    {
        return _receiptHash(electionId, nullifier, ballotHash, encryptedBallot);
    }

    function ballotHashOfCiphertext(bytes calldata encryptedBallot) public pure returns (uint256) {
        if (encryptedBallot.length >= 34 && encryptedBallot[0] == 0x41 && encryptedBallot[1] == 0x47) {
            bytes32 tag;
            assembly {
                tag := calldataload(add(encryptedBallot.offset, 2))
            }
            return uint256(tag) % SNARK_SCALAR_FIELD;
        }
        return uint256(keccak256(encryptedBallot)) % SNARK_SCALAR_FIELD;
    }

    function _reveal(
        uint256 electionId,
        uint256[2][] calldata a,
        uint256[2][2][] calldata b,
        uint256[2][] calldata c,
        uint256[][] calldata publicInputs,
        bytes[] calldata encryptedBallots
    ) internal nonReentrant {
        _requireNotPaused();
        _requireRelayer();
        uint256 n = encryptedBallots.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_REVEAL_BATCH) revert BatchTooLarge();
        if (a.length != n || b.length != n || c.length != n || publicInputs.length != n) {
            revert BatchLengthMismatch();
        }
        uint256[] memory nullifiers = new uint256[](n);
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            (nullifiers[i], hashes[i]) = _checkOne(electionId, a[i], b[i], c[i], publicInputs[i], encryptedBallots[i]);
            for (uint256 j; j < i; ++j) {
                if (nullifiers[j] == nullifiers[i]) revert DuplicateNullifier();
            }
        }
        for (uint256 i; i < n; ++i) {
            _record(electionId, nullifiers[i], hashes[i]);
        }
        emit SealedBallotsRevealed(electionId, n, _acceptedBallots[electionId]);
    }

    function _forceInclude(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot,
        bytes calldata signature
    ) internal nonReentrant {
        _requireNotPaused();
        (uint256 nullifier, bytes32 ballotHash) = _checkOne(electionId, a, b, c, publicInputs, encryptedBallot);
        bytes32 digest = _receiptHash(electionId, nullifier, ballotHash, encryptedBallot);
        address signer = _recover(digest, signature);
        if (!factory.isRelayer(signer)) revert BadSignature();
        _record(electionId, nullifier, ballotHash);
        emit SealedBallotsRevealed(electionId, 1, _acceptedBallots[electionId]);
    }

    function _checkOne(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal view returns (uint256 nullifier, bytes32 ballotHash) {
        if (_tallied[electionId]) revert AlreadyTallied();
        if (encryptedBallot.length == 0) revert EmptyBallot();
        if (encryptedBallot.length > MAX_BALLOT_BYTES) revert BallotTooLarge();
        if (publicInputs.length != 5) revert InvalidPublicInputs();
        (IElection election, ElectionParams memory p) = _vote(electionId);
        if (!election.rollFrozen()) revert RollNotFrozen();
        if (p.verifier == address(0)) revert ZeroVerifier();
        if (publicInputs[0] != uint256(election.eligibleRoot())) revert EligibleRootMismatch();
        if (publicInputs[1] != uint256(election.disqualificationRoot())) revert DisqualificationRootMismatch();
        if (publicInputs[4] != electionId) revert ElectionIdMismatch();
        if (publicInputs[3] != ballotHashOfCiphertext(encryptedBallot)) revert BallotHashMismatch();
        _rejectPendingRoot(election, electionId);

        nullifier = publicInputs[2] % SNARK_SCALAR_FIELD;
        if (nullifier == 0) revert InvalidNullifier();
        ballotHash = bytes32(publicInputs[3]);
        if (!CappedVerifierCall.accepted(p.verifier, a, b, c, publicInputs)) revert InvalidProof();
        if (_nullifierUsed[electionId][nullifier]) revert NullifierUsed();
    }

    function _record(uint256 electionId, uint256 nullifier, bytes32 ballotHash) internal {
        uint256 key = nullifier % SNARK_SCALAR_FIELD;
        _nullifierUsed[electionId][key] = true;
        _ballotHashOf[electionId][key] = ballotHash;
        _ballotHashList[electionId].push(ballotHash);
        _ballotRoot[electionId] = keccak256(abi.encodePacked(_ballotRoot[electionId], ballotHash));
        unchecked {
            _acceptedBallots[electionId] += 1;
        }
    }

    function _receiptHash(uint256 electionId, uint256 nullifier, bytes32 ballotHash, bytes calldata encryptedBallot)
        internal
        view
        returns (bytes32)
    {
        bytes32 body = keccak256(
            abi.encode("SEALED-VOTE-RECEIPT", block.chainid, address(this), electionId, nullifier, ballotHash, keccak256(encryptedBallot))
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", body));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _requireCutoff(uint256 electionId) internal view {
        ElectionParams memory p = _voteParams(electionId);
        if (block.timestamp < p.cutoffTime) revert TooEarly(electionId);
    }

    function _voteParams(uint256 electionId) internal view returns (ElectionParams memory p) {
        (, p) = _vote(electionId);
    }

    function _vote(uint256 electionId) internal view returns (IElection election, ElectionParams memory p) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        election = IElection(electionAddr);
        p = election.params();
        if (p.electionType != ElectionType.VOTE) revert NotVote();
    }

    function _requireRelayer() internal view {
        if (!factory.isRelayer(msg.sender)) revert NotRelayer();
    }

    function _requireNotPaused() internal view {
        if (factory.isPaused()) revert ContractPaused();
    }

    function _rejectPendingRoot(IElection election, uint256 electionId) internal view {
        address voters = election.voterRegistry();
        if (voters == address(0)) return;
        (bool ok, bytes memory ret) =
            voters.staticcall(abi.encodeWithSelector(IVoterRegistry.eligibleRootPending.selector, electionId));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert EligibleRootPending();
    }
}
