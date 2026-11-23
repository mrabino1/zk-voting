// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IBatchVerifier} from "./interfaces/IBatchVerifier.sol";
import {IDesertVerifier} from "./interfaces/IDesertVerifier.sol";
import {IZkVotingRollup} from "./interfaces/IZkVotingRollup.sol";
import {BabyJub} from "./libraries/BabyJub.sol";
import {Guardians} from "./libraries/Guardians.sol";
import {Ops} from "./libraries/Ops.sol";
import {ReasonCodes} from "./libraries/ReasonCodes.sol";
import {StateTree} from "./libraries/StateTree.sol";

/// @title ZkVotingRollup
/// @notice The one L1 contract of ZK-Voting. It settles an application-specific ZK rollup
///         in the Lighter / zkSync Lite pattern and enforces the election rules.
/// @dev See `docs/ROLLUP.md`. In short:
///      - Jurisdictions, elections, guardian keys and rolls are created here. Roll changes reach
///        the L2 only through the priority queue, so the operator cannot invent them.
///      - The operator commits batches. Anyone verifies (validity proof) and executes them.
///      - A ballot the operator ignores can be forced in. If the oldest queued request expires,
///        anyone can activate desert mode, which freezes the rollup for good.
///      - The final per-option ElGamal sums arrive through CLOSE. Guardians open only those
///        sums, and only when turnout reaches the election's anonymity floor. No individual
///        ballot and no partial sum is ever decrypted on L1.
///      There is no upgrade path and no pause. The verifiers are fixed at deployment.
contract ZkVotingRollup is IZkVotingRollup {
    /// @notice An L1 request must be in an executed batch within this time, or desert mode opens.
    uint256 public constant PRIORITY_EXPIRATION = 3 days;
    /// @notice A batch timestamp may trail the L1 block by at most this much.
    uint256 public constant MAX_TIMESTAMP_LAG = 15 minutes;
    uint8 public constant MAX_OPTIONS = 8;
    uint256 public constant MAX_FORCED_PAYLOAD_BYTES = 16 * 1024;

    uint256 internal constant FIELD = StateTree.FIELD;
    uint256 internal constant COMMITMENT_MASK = (uint256(1) << 253) - 1;

    IBatchVerifier public immutable batchVerifier;
    IDesertVerifier public immutable desertVerifier;

    address public governor;
    address public pendingGovernor;
    mapping(address => bool) public isOperator;

    struct Jurisdiction {
        address admin;
        string name;
    }

    mapping(bytes32 => Jurisdiction) private _jurisdictions;
    mapping(bytes32 => mapping(address => bool)) public isClerk;

    uint32 public electionCount;
    mapping(uint32 => ElectionInfo) private _elections;
    mapping(uint32 => Guardians.Committee) private _committees;
    mapping(uint32 => uint256[4][]) private _accumulators;
    mapping(uint32 => uint256[]) private _counts;
    mapping(uint32 => bytes32) private _resultHashes;

    mapping(uint64 => PriorityRequest) public priorityRequests;
    /// @notice Oldest request not yet in an executed batch.
    uint64 public firstPriorityRequestId;
    uint64 public totalPriorityRequests;
    /// @notice Requests already carried by a committed batch.
    uint64 public totalCommittedPriorityRequests;

    mapping(uint64 => bytes32) public storedBatchHashes;
    mapping(uint64 => uint64) private _committedPriorityAfter;
    uint64 public totalBatchesCommitted;
    uint64 public totalBatchesVerified;
    uint64 public totalBatchesExecuted;
    bytes32 public executedStateRoot;
    bool public desertMode;

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    modifier notDesert() {
        if (desertMode) revert DesertMode();
        _;
    }

    constructor(address governor_, IBatchVerifier batchVerifier_, IDesertVerifier desertVerifier_) {
        if (governor_ == address(0) || address(batchVerifier_) == address(0) || address(desertVerifier_) == address(0))
        {
            revert ZeroAddress();
        }
        if (batchVerifier_.isMock() && block.chainid != 31337) revert MockVerifierOnLocalChainOnly();
        governor = governor_;
        batchVerifier = batchVerifier_;
        desertVerifier = desertVerifier_;

        bytes32 root = bytes32(desertVerifier_.emptyStateRoot());
        executedStateRoot = root;
        StoredBatchInfo memory genesis = StoredBatchInfo({
            batchNumber: 0,
            timestamp: uint64(block.timestamp),
            priorityOperations: 0,
            priorityOpsHash: bytes32(0),
            onchainOpsHash: bytes32(0),
            stateRoot: root,
            commitment: bytes32(0)
        });
        storedBatchHashes[0] = keccak256(abi.encode(genesis));
        emit BatchCommitted(0, root, bytes32(0));
        emit BatchExecuted(0, root);
    }

    // =============================================================== governance

    function transferGovernor(address next) external onlyGovernor {
        if (next == address(0)) revert ZeroAddress();
        pendingGovernor = next;
        emit GovernorTransferStarted(governor, next);
    }

    function acceptGovernor() external {
        if (msg.sender != pendingGovernor) revert NotPendingGovernor();
        emit GovernorTransferred(governor, msg.sender);
        governor = msg.sender;
        pendingGovernor = address(0);
    }

    function setOperator(address operator, bool active) external onlyGovernor {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = active;
        emit OperatorSet(operator, active);
    }

    function createJurisdiction(bytes32 jurisdictionId, address admin, string calldata name) external onlyGovernor {
        if (jurisdictionId == bytes32(0) || bytes(name).length == 0) revert BadInput();
        if (admin == address(0)) revert ZeroAddress();
        if (_jurisdictions[jurisdictionId].admin != address(0)) revert JurisdictionExists();
        _jurisdictions[jurisdictionId] = Jurisdiction({admin: admin, name: name});
        emit JurisdictionCreated(jurisdictionId, admin, name);
    }

    function setJurisdictionAdmin(bytes32 jurisdictionId, address admin) external onlyGovernor {
        if (admin == address(0)) revert ZeroAddress();
        Jurisdiction storage j = _jurisdiction(jurisdictionId);
        j.admin = admin;
        emit JurisdictionAdminSet(jurisdictionId, admin);
    }

    function setClerk(bytes32 jurisdictionId, address clerk, bool active) external {
        if (msg.sender != _jurisdiction(jurisdictionId).admin) revert NotJurisdictionAdmin();
        if (clerk == address(0)) revert ZeroAddress();
        isClerk[jurisdictionId][clerk] = active;
        emit ClerkSet(jurisdictionId, clerk, active);
    }

    function jurisdiction(bytes32 jurisdictionId) external view returns (address admin, string memory name) {
        Jurisdiction storage j = _jurisdictions[jurisdictionId];
        return (j.admin, j.name);
    }

    // ================================================================ elections

    /// @inheritdoc IZkVotingRollup
    function createElection(ElectionConfig calldata config) external notDesert returns (uint32 electionId) {
        _jurisdiction(config.jurisdictionId);
        if (!isClerk[config.jurisdictionId][msg.sender]) revert NotClerk();
        if (
            config.optionCount < 2 || config.optionCount > MAX_OPTIONS || config.minBallots == 0
                || config.startTime <= block.timestamp || config.cutoffTime <= config.startTime
        ) revert BadElectionConfig();
        if (config.registrar == address(0) || config.officer == address(0)) revert ZeroAddress();

        electionId = ++electionCount;
        bytes32 configHash = keccak256(abi.encode(block.chainid, address(this), electionId, config));
        Guardians.open(_committees[electionId], config.guardians, config.threshold);
        _elections[electionId] = ElectionInfo({
            jurisdictionId: config.jurisdictionId,
            configHash: configHash,
            ballotSpecHash: config.ballotSpecHash,
            startTime: config.startTime,
            cutoffTime: config.cutoffTime,
            createdAt: uint64(block.timestamp),
            optionCount: config.optionCount,
            threshold: config.threshold,
            guardianCount: uint8(config.guardians.length),
            minBallots: config.minBallots,
            ballotCount: 0,
            status: Status.KeyGen,
            viaDesert: false,
            clerk: msg.sender,
            registrar: config.registrar,
            officer: config.officer,
            jointKeyX: 0,
            jointKeyY: 0
        });
        emit ElectionCreated(
            electionId,
            config.jurisdictionId,
            configHash,
            config.startTime,
            config.cutoffTime,
            config.optionCount,
            config.metadataURI
        );
    }

    // ---------------------------------------------------------- key ceremony

    /// @notice Guardian ceremony calls carry the guardian's own signature or are self-proving, so
    ///         any relayer may send them. See `Guardians`.
    function commitGuardian(
        uint32 electionId,
        uint8 index,
        uint256[] calldata cx,
        uint256[] calldata cy,
        Guardians.Schnorr calldata pok,
        Guardians.Schnorr calldata auth
    ) external {
        _keyGen(electionId);
        Guardians.commit(_committees[electionId], electionId, index, cx, cy, pok, auth);
        emit GuardianCommitted(electionId, index);
    }

    function complainShare(
        uint32 electionId,
        uint8 dealer,
        uint8 recipient,
        uint256 share,
        Guardians.Schnorr calldata dealerSig
    ) external {
        _keyGen(electionId);
        Guardians.complain(_committees[electionId], electionId, dealer, recipient, share, dealerSig);
        emit DealerExcluded(electionId, dealer);
    }

    function openShareDispute(uint32 electionId, uint8 dealer, uint8 recipient, Guardians.Schnorr calldata auth)
        external
    {
        _keyGen(electionId);
        Guardians.openDispute(_committees[electionId], electionId, dealer, recipient, auth);
        emit ShareDisputeOpened(electionId, dealer, recipient);
    }

    function revealShare(uint32 electionId, uint8 dealer, uint256 share) external {
        _keyGen(electionId);
        Guardians.revealShare(_committees[electionId], dealer, share);
        emit ShareDisputeClosed(electionId, dealer);
    }

    function expireShareDispute(uint32 electionId, uint8 dealer) external {
        _keyGen(electionId);
        Guardians.expireDispute(_committees[electionId], dealer);
        emit DealerExcluded(electionId, dealer);
    }

    /// @notice Fix the joint key and hand the election to the L2. Anyone may call.
    function finalizeKey(uint32 electionId) external notDesert {
        ElectionInfo storage e = _keyGen(electionId);
        (uint256 x, uint256 y) = Guardians.finalize(_committees[electionId]);
        e.jointKeyX = x;
        e.jointKeyY = y;
        e.status = Status.Scheduled;
        emit KeyFinalized(electionId, x, y);
        _enqueue(
            Ops.CREATE_ELECTION,
            Ops.encodeCreateElection(electionId, e.configHash, e.startTime, e.cutoffTime, e.optionCount, x, y)
        );
    }

    /// @notice An election whose key was not ready by `startTime` can never open.
    function haltElection(uint32 electionId) external {
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.KeyGen) revert WrongStatus(e.status);
        if (block.timestamp < e.startTime) revert TooEarly();
        e.status = Status.Halted;
        emit ElectionHalted(electionId);
    }

    // ------------------------------------------------------------------ roll

    /// @inheritdoc IZkVotingRollup
    function registerVoters(uint32 electionId, uint256[] calldata commitments) external notDesert {
        ElectionInfo storage e = _beforeStart(electionId);
        if (msg.sender != e.registrar) revert NotRegistrar();
        uint256 n = commitments.length;
        if (n == 0) revert BadInput();
        for (uint256 i; i < n; ++i) {
            if (commitments[i] == 0 || commitments[i] >= FIELD) revert BadInput();
        }
        for (uint256 from; from < n; from += Ops.MAX_REGISTER_PER_OP) {
            uint256 count = n - from < Ops.MAX_REGISTER_PER_OP ? n - from : Ops.MAX_REGISTER_PER_OP;
            _enqueue(Ops.REGISTER, Ops.encodeRegister(electionId, commitments, from, count));
        }
        emit VotersRegistered(electionId, n);
    }

    /// @inheritdoc IZkVotingRollup
    function disqualify(uint32 electionId, uint256 commitment, uint16 reasonCode) external notDesert {
        ElectionInfo storage e = _beforeStart(electionId);
        if (msg.sender != e.officer) revert NotOfficer();
        if (commitment == 0 || commitment >= FIELD || !ReasonCodes.isValid(reasonCode)) revert BadInput();
        _enqueue(Ops.DISQUALIFY, Ops.encodeDisqualify(electionId, commitment, reasonCode));
        emit VoterDisqualified(electionId, commitment, reasonCode);
    }

    // --------------------------------------------------------------- ballots

    /// @inheritdoc IZkVotingRollup
    /// @dev Censorship escape. `payload` is the ballot vector and its proof, for the operator to
    ///      apply. Its ciphertexts become public, still under the threshold key. The batch circuit
    ///      checks the proof and records `accepted` in the response byte.
    function forceBallot(uint32 electionId, uint256 nullifier, uint256 ballotCommitment, bytes calldata payload)
        external
        notDesert
        returns (uint64 requestId)
    {
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.Scheduled) revert WrongStatus(e.status);
        if (block.timestamp < e.startTime) revert TooEarly();
        if (block.timestamp >= e.cutoffTime) revert TooLate();
        if (
            nullifier == 0 || nullifier >= FIELD || ballotCommitment == 0 || ballotCommitment >= FIELD
                || payload.length == 0 || payload.length > MAX_FORCED_PAYLOAD_BYTES
        ) revert BadInput();
        requestId = _enqueue(
            Ops.FORCED_BALLOT, Ops.encodeForcedBallot(electionId, nullifier, ballotCommitment, keccak256(payload))
        );
        emit BallotForced(electionId, requestId, payload);
    }

    /// @inheritdoc IZkVotingRollup
    function closeElection(uint32 electionId) external notDesert {
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.Scheduled) revert WrongStatus(e.status);
        if (block.timestamp < e.cutoffTime) revert TooEarly();
        e.status = Status.Closing;
        _enqueue(Ops.CLOSE, Ops.encodeClose(electionId));
        emit CloseRequested(electionId);
    }

    // =================================================================== batches

    /// @inheritdoc IZkVotingRollup
    function commitBatch(StoredBatchInfo calldata last, CommitBatchInfo calldata next) external onlyOperator notDesert {
        uint64 number = totalBatchesCommitted + 1;
        if (_hash(last) != storedBatchHashes[number - 1] || last.batchNumber != number - 1) revert BadStoredBatch();
        if (
            next.timestamp < last.timestamp || next.timestamp > block.timestamp
                || next.timestamp + MAX_TIMESTAMP_LAG < block.timestamp
        ) revert BadTimestamp();

        (uint64 priorityOps, bytes32 priorityOpsHash, bytes32 onchainOpsHash) = _collectOps(next.pubdata);
        bytes32 commitment = bytes32(
            uint256(
                sha256(
                    abi.encodePacked(
                        last.stateRoot,
                        next.newStateRoot,
                        number,
                        next.timestamp,
                        sha256(next.pubdata),
                        priorityOpsHash,
                        onchainOpsHash
                    )
                )
            ) & COMMITMENT_MASK
        );
        StoredBatchInfo memory stored = StoredBatchInfo({
            batchNumber: number,
            timestamp: next.timestamp,
            priorityOperations: priorityOps,
            priorityOpsHash: priorityOpsHash,
            onchainOpsHash: onchainOpsHash,
            stateRoot: next.newStateRoot,
            commitment: commitment
        });
        storedBatchHashes[number] = keccak256(abi.encode(stored));
        totalCommittedPriorityRequests += priorityOps;
        _committedPriorityAfter[number] = totalCommittedPriorityRequests;
        totalBatchesCommitted = number;
        emit BatchCommitted(number, next.newStateRoot, commitment);
    }

    /// @inheritdoc IZkVotingRollup
    function verifyBatch(StoredBatchInfo calldata batch, uint256[8] calldata proof) external notDesert {
        uint64 number = totalBatchesVerified + 1;
        if (batch.batchNumber != number || number > totalBatchesCommitted) revert BatchNotCommitted();
        if (_hash(batch) != storedBatchHashes[number]) revert BadStoredBatch();
        if (!batchVerifier.verifyProof(proof, uint256(batch.commitment))) revert InvalidProof();
        totalBatchesVerified = number;
        emit BatchVerified(number);
    }

    /// @inheritdoc IZkVotingRollup
    function executeBatches(StoredBatchInfo[] calldata batches, bytes[] calldata onchainOps) external notDesert {
        if (batches.length != onchainOps.length) revert BadInput();
        for (uint256 i; i < batches.length; ++i) {
            StoredBatchInfo calldata batch = batches[i];
            uint64 number = totalBatchesExecuted + 1;
            if (batch.batchNumber != number) revert BadStoredBatch();
            if (number > totalBatchesVerified) revert BatchNotVerified();
            if (_hash(batch) != storedBatchHashes[number]) revert BadStoredBatch();
            if (_applyOnchainOps(onchainOps[i]) != batch.onchainOpsHash) revert OnchainOpsMismatch();

            uint64 first = firstPriorityRequestId;
            uint64 end = first + batch.priorityOperations;
            for (uint64 id = first; id < end; ++id) {
                delete priorityRequests[id];
            }
            firstPriorityRequestId = end;
            totalBatchesExecuted = number;
            executedStateRoot = batch.stateRoot;
            emit BatchExecuted(number, batch.stateRoot);
        }
    }

    /// @inheritdoc IZkVotingRollup
    function revertBatches(StoredBatchInfo calldata newLast) external onlyOperator notDesert {
        uint64 keep = newLast.batchNumber;
        if (keep < totalBatchesExecuted || keep >= totalBatchesCommitted) revert CannotRevertExecuted();
        if (_hash(newLast) != storedBatchHashes[keep]) revert BadStoredBatch();
        for (uint64 b = keep + 1; b <= totalBatchesCommitted; ++b) {
            delete storedBatchHashes[b];
            delete _committedPriorityAfter[b];
        }
        totalBatchesCommitted = keep;
        if (totalBatchesVerified > keep) totalBatchesVerified = keep;
        totalCommittedPriorityRequests = _committedPriorityAfter[keep];
        emit BatchesReverted(keep);
    }

    // ===================================================================== desert

    /// @inheritdoc IZkVotingRollup
    function activateDesertMode() external notDesert {
        uint64 first = firstPriorityRequestId;
        if (first == totalPriorityRequests || block.timestamp <= priorityRequests[first].expiration) {
            revert NoExpiredRequest();
        }
        desertMode = true;
        emit DesertModeActivated(first);
    }

    /// @inheritdoc IZkVotingRollup
    function desertClose(
        uint32 electionId,
        StateTree.ElectionLeaf calldata leaf,
        uint256[4][] calldata acc,
        uint256[] calldata siblings
    ) external {
        if (!desertMode) revert NotDesertMode();
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.Scheduled && e.status != Status.Closing) revert WrongStatus(e.status);
        if (acc.length != e.optionCount || leaf.configHash != uint256(e.configHash) % FIELD) revert BadDesertProof();
        if (!desertVerifier.verifyElection(uint256(executedStateRoot), electionId, leaf, acc, siblings)) {
            revert BadDesertProof();
        }
        if (leaf.ballotCount > type(uint32).max) revert BadDesertProof();
        _close(electionId, e, uint32(leaf.ballotCount), acc, true);
    }

    // ==================================================================== results

    /// @inheritdoc IZkVotingRollup
    /// @dev Self-proving (Chaum-Pedersen against `PK_index`), so any relayer may send it.
    function postDecryptionShares(uint32 electionId, uint8 guardianIndex, Guardians.Share[] calldata shares) external {
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.Closed) revert WrongStatus(e.status);
        uint256[4][] storage acc = _accumulators[electionId];
        uint256[2][] memory c1 = new uint256[2][](acc.length);
        for (uint256 o; o < acc.length; ++o) {
            c1[o] = [acc[o][0], acc[o][1]];
        }
        Guardians.postShares(_committees[electionId], electionId, guardianIndex, c1, shares);
        emit DecryptionSharesPosted(electionId, guardianIndex);
    }

    /// @inheritdoc IZkVotingRollup
    /// @dev The only decryption L1 accepts: `c2 − Σ λ D = count · G` for every option of the final
    ///      sum, with the counts adding up to the ballot count. Anyone may call.
    function finalizeResult(uint32 electionId, uint256[] calldata counts, uint8[] calldata guardianIndexes) external {
        ElectionInfo storage e = _election(electionId);
        if (e.status != Status.Closed) revert WrongStatus(e.status);
        if (counts.length != e.optionCount) revert CountMismatch();
        uint256 total;
        for (uint256 o; o < counts.length; ++o) {
            total += counts[o];
        }
        if (total != e.ballotCount) revert CountMismatch();

        Guardians.Committee storage c = _committees[electionId];
        uint256[4][] storage acc = _accumulators[electionId];
        for (uint256 o; o < counts.length; ++o) {
            (uint256 mx, uint256 my) = Guardians.combine(c, o, acc[o][2], acc[o][3], guardianIndexes);
            (uint256 ex, uint256 ey) = BabyJub.mulBase(counts[o]);
            if (mx != ex || my != ey) revert DecryptionMismatch();
        }
        bytes32 resultHash = keccak256(abi.encode(block.chainid, address(this), electionId, counts));
        _counts[electionId] = counts;
        _resultHashes[electionId] = resultHash;
        e.status = Status.Finalized;
        emit ResultFinalized(electionId, resultHash, counts);
    }

    // ====================================================================== views

    /// @inheritdoc IZkVotingRollup
    /// @dev In desert mode an election that never closed reads as `Halted`.
    function election(uint32 electionId) external view returns (ElectionInfo memory info) {
        info = _election(electionId);
        if (
            desertMode
                && (info.status == Status.KeyGen || info.status == Status.Scheduled || info.status == Status.Closing)
        ) info.status = Status.Halted;
    }

    /// @inheritdoc IZkVotingRollup
    function result(uint32 electionId) external view returns (uint256[] memory counts, bytes32 resultHash) {
        return (_counts[electionId], _resultHashes[electionId]);
    }

    /// @inheritdoc IZkVotingRollup
    function accumulator(uint32 electionId) external view returns (uint256[4][] memory) {
        return _accumulators[electionId];
    }

    function guardian(uint32 electionId, uint8 index)
        external
        view
        returns (uint256 keyX, uint256 keyY, bool committed, bool excluded, bool sharesPosted)
    {
        Guardians.Committee storage c = _committees[electionId];
        uint32 bit = uint32(1) << index;
        uint256[2] storage id = c.identity[index];
        return (id[0], id[1], c.cx[index].length != 0, c.excluded & bit != 0, c.sharesPosted & bit != 0);
    }

    function guardianCommitments(uint32 electionId, uint8 index)
        external
        view
        returns (uint256[] memory cx, uint256[] memory cy)
    {
        Guardians.Committee storage c = _committees[electionId];
        return (c.cx[index], c.cy[index]);
    }

    /// @notice The `D = s · c1` points guardian `index` posted, one per option (empty before).
    ///         With the accumulator they let anyone compute the totals `finalizeResult` checks.
    function decryptionShares(uint32 electionId, uint8 index) external view returns (uint256[2][] memory out) {
        Guardians.Committee storage c = _committees[electionId];
        if (c.sharesPosted & (uint32(1) << index) == 0) return out;
        uint256 options = _accumulators[electionId].length;
        out = new uint256[2][](options);
        for (uint256 o; o < options; ++o) {
            out[o] = c.share[index][o];
        }
    }

    /// @notice Guardian `index`'s public decryption key `PK = s · G`.
    function guardianPublicShare(uint32 electionId, uint8 index) external view returns (uint256 x, uint256 y) {
        return Guardians.publicShare(_committees[electionId], index);
    }

    function committeeState(uint32 electionId)
        external
        view
        returns (uint8 committed, uint32 excluded, uint32 disputed, uint64 openedAt, uint64 lastCommitAt)
    {
        Guardians.Committee storage c = _committees[electionId];
        return (c.committed, c.excluded, c.disputed, c.openedAt, c.lastCommitAt);
    }

    /// @notice Requests waiting for an executed batch.
    function openPriorityRequests() external view returns (uint64) {
        return totalPriorityRequests - firstPriorityRequestId;
    }

    // =================================================================== internal

    function _enqueue(uint8 opType, bytes memory pubdata) internal returns (uint64 id) {
        id = totalPriorityRequests;
        uint64 expiration = uint64(block.timestamp + PRIORITY_EXPIRATION);
        priorityRequests[id] =
            PriorityRequest({hashedPubdata: keccak256(pubdata), expiration: expiration, opType: opType});
        totalPriorityRequests = id + 1;
        emit PriorityRequestQueued(id, opType, pubdata, expiration);
    }

    /// @dev Walks the pubdata. Each priority op must match the next queued request, in order.
    ///      CLOSE ops are also chained into the on-chain operations hash for `executeBatches`.
    function _collectOps(bytes calldata pubdata)
        internal
        view
        returns (uint64 count, bytes32 priorityOpsHash, bytes32 onchainOpsHash)
    {
        uint64 cursor = totalCommittedPriorityRequests;
        uint256 offset;
        while (offset < pubdata.length) {
            (uint8 opType, uint256 size, uint256 requestSize) = Ops.sizeAt(pubdata, offset);
            if (requestSize != 0) {
                if (cursor >= totalPriorityRequests) revert MissingPriorityOps();
                PriorityRequest storage r = priorityRequests[cursor];
                if (r.opType != opType || keccak256(pubdata[offset:offset + requestSize]) != r.hashedPubdata) {
                    revert PriorityOpMismatch();
                }
                priorityOpsHash = keccak256(abi.encode(priorityOpsHash, r.hashedPubdata));
                unchecked {
                    ++cursor;
                    ++count;
                }
                if (opType == Ops.CLOSE) {
                    onchainOpsHash = keccak256(abi.encode(onchainOpsHash, keccak256(pubdata[offset:offset + size])));
                }
            }
            offset += size;
        }
    }

    /// @dev Applies the CLOSE responses of one executed batch and returns their chained hash.
    function _applyOnchainOps(bytes calldata ops) internal returns (bytes32 chained) {
        uint256 offset;
        while (offset < ops.length) {
            (uint8 opType, uint256 size,) = Ops.sizeAt(ops, offset);
            if (opType != Ops.CLOSE) revert OnchainOpsMismatch();
            chained = keccak256(abi.encode(chained, keccak256(ops[offset:offset + size])));

            uint32 electionId = Ops.electionIdAt(ops, offset);
            ElectionInfo storage e = _election(electionId);
            if (e.status != Status.Closing) revert OnchainOpsMismatch();
            uint32 ballots = uint32(bytes4(ops[offset + 5:offset + 9]));
            uint256 options = uint8(ops[offset + 9]);
            if (options != e.optionCount) revert OnchainOpsMismatch();
            uint256[4][] memory acc = new uint256[4][](options);
            uint256 base = offset + Ops.CLOSE_REQUEST_BYTES + Ops.CLOSE_RESPONSE_HEADER_BYTES;
            for (uint256 o; o < options; ++o) {
                for (uint256 w; w < 4; ++w) {
                    acc[o][w] = Ops.wordAt(ops, base + o * Ops.CIPHERTEXT_BYTES + w * 32);
                }
            }
            _close(electionId, e, ballots, acc, false);
            offset += size;
        }
    }

    function _close(uint32 electionId, ElectionInfo storage e, uint32 ballots, uint256[4][] memory acc, bool viaDesert)
        internal
    {
        uint256[4][] storage stored = _accumulators[electionId];
        for (uint256 o; o < acc.length; ++o) {
            if (!BabyJub.onCurve(acc[o][0], acc[o][1]) || !BabyJub.onCurve(acc[o][2], acc[o][3])) {
                revert OnchainOpsMismatch();
            }
            stored.push(acc[o]);
        }
        bool withheld = ballots < e.minBallots;
        e.ballotCount = ballots;
        e.viaDesert = viaDesert;
        e.status = withheld ? Status.Withheld : Status.Closed;
        emit ElectionClosed(electionId, ballots, withheld, viaDesert);
    }

    function _hash(StoredBatchInfo calldata info) internal pure returns (bytes32) {
        return keccak256(abi.encode(info));
    }

    function _jurisdiction(bytes32 jurisdictionId) internal view returns (Jurisdiction storage j) {
        j = _jurisdictions[jurisdictionId];
        if (j.admin == address(0)) revert UnknownJurisdiction();
    }

    function _election(uint32 electionId) internal view returns (ElectionInfo storage e) {
        e = _elections[electionId];
        if (e.status == Status.None) revert UnknownElection();
    }

    function _keyGen(uint32 electionId) internal view returns (ElectionInfo storage e) {
        e = _election(electionId);
        if (e.status != Status.KeyGen) revert WrongStatus(e.status);
        if (block.timestamp >= e.startTime) revert TooLate();
    }

    function _beforeStart(uint32 electionId) internal view returns (ElectionInfo storage e) {
        e = _election(electionId);
        if (e.status != Status.Scheduled) revert WrongStatus(e.status);
        if (block.timestamp >= e.startTime) revert TooLate();
    }
}
