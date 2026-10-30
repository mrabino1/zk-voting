// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../interfaces/ElectionParams.sol";
import {IBallotInbox} from "../interfaces/IBallotInbox.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";
import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IRollupSettlement} from "../interfaces/IRollupSettlement.sol";

/// @title RollupSettlement
/// @notice L1 settlement for ZK-Voting L2 (app-specific ZK rollup). No token.
/// @dev Audit H-06: outside `mockMode` a batch verifier is mandatory (constructor
///      reverts `VerifierRequired`) and every batch is verified. Public inputs
///      are reduced mod r so a snarkjs verifier never rejects them for being
///      out of field. `mockMode` is a constructor-time, explicit dev/test flag.
contract RollupSettlement is IRollupSettlement {
    bytes32 public constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");
    bytes32 public constant PROVER_ROLE = keccak256("PROVER_ROLE");

    /// @notice BN254 scalar field modulus r.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address public admin;
    address public sequencer;
    address public prover;
    address public batchVerifier;
    bool public mockMode;
    bytes32 public stateRoot;
    uint64 public batchCount;
    mapping(uint64 => Batch) private _batches;
    /// @notice Audit M-05: every L2 state root this contract has settled
    ///         (genesis or a batch's `newStateRoot`), for `L1TallyMirror`.
    mapping(bytes32 => bool) public isSettledRoot;

    /// @notice One hour. An honest sequencer can land the supplementary batch in that time.
    ///         A stall cannot hold the tally for longer than one missed hour.
    uint256 public constant SUPPLEMENTARY_GRACE = 1 hours;
    uint8 public constant KIND_HOURLY = 1;
    uint8 public constant KIND_FINAL = 2;
    uint8 public constant KIND_SUPPLEMENTARY = 3;

    address public electionFactory;
    address public inbox;
    mapping(uint256 => bool) private _supplementaryPosted;
    mapping(uint256 => bytes32) private _lastHourlyRoot;
    mapping(uint256 => bool) private _finalPosted;
    mapping(uint256 => bytes32) private _finalRoot;
    mapping(uint256 => bytes32) private _hourlyProduct;
    mapping(uint256 => bytes32) private _finalProduct;
    mapping(uint256 => bytes32[]) private _roots;
    mapping(uint256 => mapping(bytes32 => uint256)) private _rootIndex;

    constructor(address admin_, address sequencer_, address prover_, address batchVerifier_, bool mockMode_) {
        if (admin_ == address(0) || sequencer_ == address(0) || prover_ == address(0)) revert ZeroAddress();
        if (!mockMode_ && batchVerifier_ == address(0)) revert VerifierRequired();
        admin = admin_;
        sequencer = sequencer_;
        prover = prover_;
        batchVerifier = batchVerifier_;
        mockMode = mockMode_;
    }

    modifier onlyOperator() {
        if (msg.sender != sequencer && msg.sender != prover && msg.sender != admin) revert NotAuthorized();
        _;
    }

    /// @notice Rotate the sequencer or prover. Admin only; other roles revert.
    function grantRole(bytes32 role, address account) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (account == address(0)) revert ZeroAddress();
        if (role == SEQUENCER_ROLE) {
            sequencer = account;
            emit SequencerSet(account);
        } else if (role == PROVER_ROLE) {
            prover = account;
            emit ProverSet(account);
        } else {
            revert UnsupportedRole();
        }
    }

    function setGenesis(bytes32 genesisRoot) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (batchCount != 0) revert GenesisAlreadySet();
        stateRoot = genesisRoot;
        isSettledRoot[genesisRoot] = true;
        emit GenesisSet(genesisRoot);
    }

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot));
    }

    function hashBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot) external pure returns (bytes32) {
        return computeDataHash(batchIndex, prevStateRoot, newStateRoot);
    }

    function submitBatch(
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external onlyOperator {
        if (batchIndex != batchCount) revert BadBatchIndex();
        if (prevStateRoot != stateRoot) revert PrevRootMismatch();
        if (dataHash != computeDataHash(batchIndex, prevStateRoot, newStateRoot)) revert DataHashMismatch();

        if (!mockMode) {
            uint256[] memory input = batchPublicInputs(batchIndex, prevStateRoot, newStateRoot, dataHash);
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }

        _batches[batchIndex] = Batch({
            prevStateRoot: prevStateRoot,
            newStateRoot: newStateRoot,
            dataHash: dataHash,
            l1Block: block.number,
            dataLength: 0
        });
        stateRoot = newStateRoot;
        isSettledRoot[newStateRoot] = true;
        unchecked {
            batchCount += 1;
        }
        emit BatchSubmitted(batchIndex, newStateRoot, dataHash, block.number);
    }

    /// @notice Groth16 instance for a batch; every word is reduced mod r.
    function batchPublicInputs(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash)
        public
        pure
        returns (uint256[] memory input)
    {
        input = new uint256[](4);
        input[0] = uint256(prevStateRoot) % SNARK_SCALAR_FIELD;
        input[1] = uint256(newStateRoot) % SNARK_SCALAR_FIELD;
        input[2] = uint256(dataHash) % SNARK_SCALAR_FIELD;
        input[3] = uint256(batchIndex);
    }

    function getBatch(uint64 batchIndex) external view returns (Batch memory) {
        return _batches[batchIndex];
    }

    function setElectionFactory(address factory_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (factory_ == address(0)) revert ZeroAddress();
        if (electionFactory != address(0) && electionFactory != factory_) revert AlreadySet();
        electionFactory = factory_;
    }

    function setInbox(address inbox_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (inbox_ == address(0)) revert ZeroAddress();
        if (inbox != address(0) && inbox != inbox_) revert AlreadySet();
        inbox = inbox_;
    }

    function supplementaryPosted(uint256 electionId) external view returns (bool) {
        return _supplementaryPosted[electionId];
    }

    function lastHourlyRoot(uint256 electionId) external view returns (bytes32) {
        return _lastHourlyRoot[electionId];
    }

    function finalBatchPosted(uint256 electionId) external view returns (bool) {
        return _finalPosted[electionId];
    }

    function finalBatchRoot(uint256 electionId) external view returns (bytes32) {
        return _finalRoot[electionId];
    }

    function finalProduct(uint256 electionId) external view returns (bytes32) {
        return _finalProduct[electionId];
    }

    function hourlyProduct(uint256 electionId) external view returns (bytes32) {
        return _hourlyProduct[electionId];
    }

    function postedBallotRoot(uint256 electionId, bytes32 root) external view returns (bool) {
        return root == bytes32(0) || _rootIndex[electionId][root] != 0;
    }

    function supplementaryChainHash(uint256 electionId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(_roots[electionId]));
    }

    function hashWords(bytes32[] calldata words) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(words));
    }

    function computeSealedDataHash(SealedParams memory params, uint8 kind) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                params.batchIndex,
                params.prevStateRoot,
                params.newStateRoot,
                params.ballotSetRoot,
                params.hourlyProduct,
                params.finalProduct,
                params.previousUnique,
                params.nextUnique,
                kind,
                params.electionId,
                params.chainHash,
                params.tagHash,
                params.boundRootHash
            )
        );
    }

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _onlyOperator();
        _prepareHourOrFinal(params, KIND_HOURLY, boundRoots, firstBallotTags);
        _verifyAndStore(params, a, b, c);
        _rememberRoot(params);
        _commitUnique(params.electionId, params.nextUnique);
        emit SealedBatchPosted(
            params.electionId, KIND_HOURLY, params.batchIndex, params.ballotSetRoot, params.nextUnique
        );
    }

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _onlyOperator();
        _prepareHourOrFinal(params, KIND_FINAL, boundRoots, firstBallotTags);
        _verifyAndStore(params, a, b, c);
        _finalPosted[params.electionId] = true;
        _finalRoot[params.electionId] = params.ballotSetRoot;
        _rememberRoot(params);
        emit SealedBatchPosted(
            params.electionId, KIND_FINAL, params.batchIndex, params.ballotSetRoot, params.previousUnique
        );
    }

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        _authSupplementary(known, allowedAt);
        if (!_finalPosted[params.electionId]) revert FinalBatchRequired();
        if (_supplementaryPosted[params.electionId]) revert SupplementaryAlreadyPosted();
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        if (params.hourlyProduct != _hourlyProduct[params.electionId]) revert HourlyProductChanged();
        if (params.chainHash != supplementaryChainHash(params.electionId)) revert DataHashMismatch();
        _checkSealedHash(params, KIND_SUPPLEMENTARY);
        _coverPending(params.electionId, includedIds);
        _verifyAndStore(params, a, b, c);
        _finalProduct[params.electionId] = params.finalProduct;
        _commitUnique(params.electionId, params.nextUnique);
        if (inbox != address(0)) IBallotInbox(inbox).markSealed(params.electionId, includedIds);
        _supplementaryPosted[params.electionId] = true;
        emit SupplementaryPosted(params.electionId);
        emit SealedBatchPosted(
            params.electionId, KIND_SUPPLEMENTARY, params.batchIndex, params.ballotSetRoot, params.nextUnique
        );
    }

    function _onlyOperator() internal view {
        if (msg.sender != sequencer && msg.sender != prover && msg.sender != admin) revert NotAuthorized();
    }

    function _prepareHourOrFinal(
        SealedParams calldata params,
        uint8 kind,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags
    ) internal view {
        (bool known, uint64 cutoff,) = _cutoff(params.electionId);
        if (kind == KIND_HOURLY) {
            if (known && block.timestamp >= cutoff) revert HourlyWindowClosed();
            if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        } else {
            if (known && block.timestamp < cutoff) revert FinalBatchTooEarly();
            if (_finalPosted[params.electionId]) revert FinalBatchAlreadyPosted();
            if (params.nextUnique != params.previousUnique) revert TurnoutOnFinalBatch();
        }
        if (params.chainHash != bytes32(0)) revert DataHashMismatch();
        if (params.ballotSetRoot == bytes32(0)) revert EmptyRoot();
        _checkBoundRoots(params.electionId, boundRoots);
        _checkFirstTags(firstBallotTags);
        if (params.tagHash != keccak256(abi.encodePacked(firstBallotTags))) revert DataHashMismatch();
        if (params.boundRootHash != keccak256(abi.encodePacked(boundRoots))) revert DataHashMismatch();
        _checkSealedHash(params, kind);
    }

    function _checkBoundRoots(uint256 electionId, bytes32[] calldata boundRoots) internal view {
        bytes32 expect = _lastHourlyRoot[electionId];
        for (uint256 i; i < boundRoots.length; ++i) {
            if (boundRoots[i] != expect) revert BoundRootMismatch();
        }
    }

    function _checkFirstTags(bytes32[] calldata tags) internal pure {
        uint256 n = tags.length;
        for (uint256 i; i < n; ++i) {
            if (tags[i] == bytes32(0)) revert DuplicateFirstBallot();
            for (uint256 j; j < i; ++j) {
                if (tags[i] == tags[j]) revert DuplicateFirstBallot();
            }
        }
    }

    function _checkSealedHash(SealedParams calldata params, uint8 kind) internal view {
        if (params.batchIndex != batchCount) revert BadBatchIndex();
        if (params.prevStateRoot != stateRoot) revert PrevRootMismatch();
        if (params.dataHash != computeSealedDataHash(params, kind)) revert DataHashMismatch();
    }

    function _verifyAndStore(
        SealedParams calldata params,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal {
        if (!mockMode) {
            uint256[] memory input = batchPublicInputs(
                params.batchIndex, params.prevStateRoot, params.newStateRoot, params.dataHash
            );
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }
        _batches[params.batchIndex] = Batch({
            prevStateRoot: params.prevStateRoot,
            newStateRoot: params.newStateRoot,
            dataHash: params.dataHash,
            l1Block: block.number,
            dataLength: 0
        });
        stateRoot = params.newStateRoot;
        isSettledRoot[params.newStateRoot] = true;
        unchecked {
            batchCount += 1;
        }
        emit BatchSubmitted(params.batchIndex, params.newStateRoot, params.dataHash, block.number);
    }

    function _rememberRoot(SealedParams calldata params) internal {
        _lastHourlyRoot[params.electionId] = params.ballotSetRoot;
        _roots[params.electionId].push(params.ballotSetRoot);
        _rootIndex[params.electionId][params.ballotSetRoot] = _roots[params.electionId].length;
        _hourlyProduct[params.electionId] = params.hourlyProduct;
        _finalProduct[params.electionId] = params.finalProduct;
    }

    function _commitUnique(uint256 electionId, uint256 uniqueCount) internal {
        if (inbox == address(0)) return;
        (bool ok, bytes memory ret) = inbox.staticcall(abi.encodeWithSignature("settlement()"));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(this)) return;
        IBallotInbox(inbox).commitUniqueCount(electionId, uniqueCount);
    }

    function _coverPending(uint256 electionId, uint256[] calldata included) internal view {
        if (inbox == address(0)) return;
        uint256[] memory forced = IBallotInbox(inbox).pendingForcedIn(electionId);
        uint256[] memory held = IBallotInbox(inbox).pendingHeld(electionId);
        if (included.length != forced.length + held.length) revert PendingBallotOmitted();
        _eachIncluded(forced, included);
        _eachIncluded(held, included);
        for (uint256 i; i < forced.length; ++i) {
            (bytes32 root, bool pending) = IBallotInbox(inbox).forcedInRoot(electionId, forced[i]);
            if (!pending || (root != bytes32(0) && _rootIndex[electionId][root] == 0)) revert UnknownBoundRoot();
        }
    }

    function _eachIncluded(uint256[] memory pending, uint256[] calldata included) internal pure {
        for (uint256 i; i < pending.length; ++i) {
            bool found;
            for (uint256 j; j < included.length; ++j) {
                if (pending[i] == included[j]) found = true;
            }
            if (!found) revert PendingBallotOmitted();
        }
    }

    function _authSupplementary(bool known, uint256 allowedAt) internal view {
        if (known && block.timestamp < allowedAt) revert SupplementaryTooEarly();
        if (!known || block.timestamp < allowedAt + SUPPLEMENTARY_GRACE) _onlyOperator();
    }

    function _allowedAt(uint256 electionId) internal view returns (bool known, uint256 allowedAt) {
        (known,, allowedAt) = _cutoff(electionId);
    }

    function _cutoff(uint256 electionId) internal view returns (bool known, uint64 cutoff, uint256 allowedAt) {
        if (electionFactory == address(0)) return (false, 0, 0);
        address el = IElectionFactory(electionFactory).getElection(electionId);
        if (el == address(0)) return (false, 0, 0);
        ElectionParams memory params = IElection(el).params();
        cutoff = params.cutoffTime;
        address tally = IElectionFactory(electionFactory).tallyVerifier();
        if (tally == address(0)) return (true, cutoff, uint256(cutoff));
        (bool ok, bytes memory ret) = tally.staticcall(abi.encodeWithSignature("tallyAllowedAt(uint256)", electionId));
        if (!ok || ret.length < 32) return (true, cutoff, uint256(cutoff));
        allowedAt = abi.decode(ret, (uint256));
        known = true;
    }
}
