// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {ZkVotingRollup} from "../../src/ZkVotingRollup.sol";
import {IZkVotingRollup} from "../../src/interfaces/IZkVotingRollup.sol";
import {BabyJub} from "../../src/libraries/BabyJub.sol";
import {Guardians} from "../../src/libraries/Guardians.sol";
import {Ops} from "../../src/libraries/Ops.sol";
import {DesertVerifier} from "../../src/verifiers/DesertVerifier.sol";
import {MockBatchVerifier} from "../../src/verifiers/MockBatchVerifier.sol";

/// @notice Shared fixture: a deployed rollup, one jurisdiction, and helpers that play the
///         guardians, the voters and the L2 operator with real Baby Jubjub arithmetic.
abstract contract RollupTest is Test {
    uint256 internal constant ORDER = BabyJub.ORDER;
    bytes32 internal constant JURISDICTION = keccak256("springfield");

    ZkVotingRollup internal rollup;
    DesertVerifier internal desert;

    address internal governor = makeAddr("governor");
    address internal operator = makeAddr("operator");
    address internal jurisdictionAdmin = makeAddr("jurisdictionAdmin");
    address internal clerk = makeAddr("clerk");
    address internal registrar = makeAddr("registrar");
    address internal officer = makeAddr("officer");
    /// @dev Guardian identity keys (index = position + 1). Secrets are `identitySecret(i)`.
    uint256[2][] internal guardianKeys;
    /// @dev Relays guardian calls; any account may.
    address internal relayer = makeAddr("relayer");

    /// @dev Latest committed batch, as the operator tracks it.
    IZkVotingRollup.StoredBatchInfo internal lastBatch;
    /// @dev Committed but not yet executed batches, oldest first, with their on-chain ops.
    IZkVotingRollup.StoredBatchInfo[] internal pendingBatches;
    bytes[] internal pendingOnchainOps;
    uint256 internal stateNonce;

    /// @dev Simulated L2 accumulator per election: option → (c1x, c1y, c2x, c2y).
    mapping(uint32 => uint256[4][]) internal l2Acc;
    mapping(uint32 => uint32) internal l2Ballots;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        desert = new DesertVerifier();
        rollup = new ZkVotingRollup(governor, new MockBatchVerifier(), desert);
        lastBatch = IZkVotingRollup.StoredBatchInfo({
            batchNumber: 0,
            timestamp: uint64(block.timestamp),
            priorityOperations: 0,
            priorityOpsHash: bytes32(0),
            onchainOpsHash: bytes32(0),
            stateRoot: rollup.executedStateRoot(),
            commitment: bytes32(0)
        });

        vm.startPrank(governor);
        rollup.setOperator(operator, true);
        rollup.createJurisdiction(JURISDICTION, jurisdictionAdmin, "Springfield");
        vm.stopPrank();
        vm.prank(jurisdictionAdmin);
        rollup.setClerk(JURISDICTION, clerk, true);

        for (uint8 i = 1; i <= 3; ++i) {
            (uint256 x, uint256 y) = BabyJub.mulBase(identitySecret(i));
            guardianKeys.push([x, y]);
        }
    }

    // ------------------------------------------------------------- elections

    function defaultConfig() internal view returns (IZkVotingRollup.ElectionConfig memory c) {
        c.jurisdictionId = JURISDICTION;
        c.startTime = uint64(block.timestamp + 2 days);
        c.cutoffTime = uint64(block.timestamp + 3 days);
        c.optionCount = 3;
        c.minBallots = 3;
        c.registrar = registrar;
        c.officer = officer;
        c.guardians = guardianKeys;
        c.threshold = 2;
        c.ballotSpecHash = keccak256("Which park gets the new playground?");
        c.metadataURI = "ipfs://ballot";
    }

    function createElection() internal returns (uint32) {
        return createElection(defaultConfig());
    }

    function createElection(IZkVotingRollup.ElectionConfig memory c) internal returns (uint32 id) {
        vm.prank(clerk);
        id = rollup.createElection(c);
    }

    /// @dev Create, run the full key ceremony, finalize the key. Returns the election id.
    function scheduledElection() internal returns (uint32 id) {
        id = createElection();
        commitAllGuardians(id);
        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        rollup.finalizeKey(id);
    }

    function info(uint32 id) internal view returns (IZkVotingRollup.ElectionInfo memory) {
        return rollup.election(id);
    }

    // ---------------------------------------------------------------- guardians

    /// @dev Coefficient `t` of guardian `i`'s polynomial.
    function coeff(uint8 i, uint256 t) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("coefficient", i, t))) % ORDER;
    }

    function commitments(uint8 i, uint256 k) internal pure returns (uint256[] memory cx, uint256[] memory cy) {
        cx = new uint256[](k);
        cy = new uint256[](k);
        for (uint256 t; t < k; ++t) {
            (cx[t], cy[t]) = BabyJub.mulBase(coeff(i, t));
        }
    }

    function identitySecret(uint8 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("identity", i))) % ORDER;
    }

    /// @dev Guardian `i`'s identity-key signature over `message`.
    function sign(uint32 id, uint8 i, bytes32 message) internal view returns (Guardians.Schnorr memory sig) {
        uint256 nonce = uint256(keccak256(abi.encode("auth", id, i, message))) % ORDER;
        (sig.rX, sig.rY) = BabyJub.mulBase(nonce);
        uint256 e = uint256(
            keccak256(abi.encode(Guardians.AUTH_DOMAIN, block.chainid, address(rollup), id, i, message, sig.rX, sig.rY))
        ) % ORDER;
        sig.z = addmod(nonce, mulmod(e, identitySecret(i), ORDER), ORDER);
    }

    function pokOf(uint32 id, uint8 i, uint256[] memory cx, uint256[] memory cy)
        internal
        view
        returns (Guardians.Schnorr memory pok)
    {
        uint256 nonce = uint256(keccak256(abi.encode("pok", i))) % ORDER;
        (pok.rX, pok.rY) = BabyJub.mulBase(nonce);
        uint256 e = uint256(
            keccak256(abi.encode(Guardians.POK_DOMAIN, block.chainid, address(rollup), id, i, cx, cy, pok.rX, pok.rY))
        ) % ORDER;
        pok.z = addmod(nonce, mulmod(e, coeff(i, 0), ORDER), ORDER);
    }

    function commitGuardian(uint32 id, uint8 i) internal {
        uint256 k = info(id).threshold;
        (uint256[] memory cx, uint256[] memory cy) = commitments(i, k);
        vm.prank(relayer);
        rollup.commitGuardian(id, i, cx, cy, pokOf(id, i, cx, cy), sign(id, i, keccak256(abi.encode("commit", cx, cy))));
    }

    function commitAllGuardians(uint32 id) internal {
        for (uint8 i = 1; i <= guardianKeys.length; ++i) {
            commitGuardian(id, i);
        }
    }

    /// @dev `f_dealer(at)`.
    function dealtShare(uint8 dealer, uint8 at, uint256 k) internal pure returns (uint256 s) {
        uint256 pow = 1;
        for (uint256 t; t < k; ++t) {
            s = addmod(s, mulmod(coeff(dealer, t), pow, ORDER), ORDER);
            pow = mulmod(pow, at, ORDER);
        }
    }

    /// @dev Guardian `j`'s secret share, summed over dealers that are in good standing.
    function secretShare(uint32 id, uint8 j) internal view returns (uint256 s) {
        uint256 k = info(id).threshold;
        for (uint8 i = 1; i <= guardianKeys.length; ++i) {
            (,, bool committed, bool excluded,) = rollup.guardian(id, i);
            if (committed && !excluded) s = addmod(s, dealtShare(i, j, k), ORDER);
        }
    }

    function shareChallenge(uint32 id, uint8 dealer, uint8 recipient, uint256 share, uint256 rX, uint256 rY)
        internal
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
            abi.encode(Guardians.SHARE_DOMAIN, block.chainid, address(rollup), id, dealer, recipient, share, rX, rY)
        )
        ) % ORDER;
    }

    /// @dev Dealer's Schnorr signature on one share (under `C_0`), as sent off chain.
    function signShare(uint32 id, uint8 dealer, uint8 recipient, uint256 share)
        internal
        view
        returns (Guardians.Schnorr memory sig)
    {
        uint256 nonce = uint256(keccak256(abi.encode("share-sig", dealer, recipient, share))) % ORDER;
        (sig.rX, sig.rY) = BabyJub.mulBase(nonce);
        uint256 e = shareChallenge(id, dealer, recipient, share, sig.rX, sig.rY);
        sig.z = addmod(nonce, mulmod(e, coeff(dealer, 0), ORDER), ORDER);
    }

    function decryptionShares(uint32 id, uint8 j) internal view returns (Guardians.Share[] memory shares) {
        uint256 s = secretShare(id, j);
        (uint256 pkX, uint256 pkY) = BabyJub.mulBase(s);
        uint256[4][] memory acc = rollup.accumulator(id);
        shares = new Guardians.Share[](acc.length);
        for (uint256 o; o < acc.length; ++o) {
            Guardians.Share memory sh;
            (sh.dX, sh.dY) = BabyJub.mul(acc[o][0], acc[o][1], s);
            uint256 w = uint256(keccak256(abi.encode("cp", j, o))) % ORDER;
            (sh.aX, sh.aY) = BabyJub.mulBase(w);
            (sh.bX, sh.bY) = BabyJub.mul(acc[o][0], acc[o][1], w);
            uint256 e = uint256(
                keccak256(
                    abi.encode(
                        Guardians.DECRYPT_DOMAIN,
                        block.chainid,
                        address(rollup),
                        id,
                        o,
                        j,
                        [pkX, pkY],
                        [acc[o][0], acc[o][1]],
                        [sh.dX, sh.dY],
                        [sh.aX, sh.aY],
                        [sh.bX, sh.bY]
                    )
                )
            ) % ORDER;
            sh.z = addmod(w, mulmod(e, s, ORDER), ORDER);
            shares[o] = sh;
        }
    }

    function postShares(uint32 id, uint8 j) internal {
        Guardians.Share[] memory shares = decryptionShares(id, j);
        vm.prank(relayer);
        rollup.postDecryptionShares(id, j, shares);
    }

    // -------------------------------------------------------------------- voters

    /// @dev Encrypt a one-hot vote for `choice` under the joint key and add it to the L2 sum.
    function castOnL2(uint32 id, uint256 choice, uint256 seed) internal returns (bytes memory op) {
        IZkVotingRollup.ElectionInfo memory e = info(id);
        if (l2Acc[id].length == 0) {
            for (uint256 o; o < e.optionCount; ++o) {
                l2Acc[id].push([uint256(0), 1, 0, 1]);
            }
        }
        uint256 commitment = seed + 1;
        for (uint256 o; o < e.optionCount; ++o) {
            uint256 r = uint256(keccak256(abi.encode("ballot", seed, o))) % ORDER;
            (uint256 c1x, uint256 c1y) = BabyJub.mulBase(r);
            (uint256 kx, uint256 ky) = BabyJub.mul(e.jointKeyX, e.jointKeyY, r);
            (uint256 mx, uint256 my) = BabyJub.mulBase(o == choice ? 1 : 0);
            (uint256 c2x, uint256 c2y) = BabyJub.add(mx, my, kx, ky);
            uint256[4] storage a = l2Acc[id][o];
            (a[0], a[1]) = BabyJub.add(a[0], a[1], c1x, c1y);
            (a[2], a[3]) = BabyJub.add(a[2], a[3], c2x, c2y);
            commitment = uint256(keccak256(abi.encode(commitment, c1x, c2x))) % BabyJub.P;
        }
        l2Ballots[id] += 1;
        uint256 nullifier = uint256(keccak256(abi.encode("nullifier", id, seed))) % BabyJub.P;
        op = abi.encodePacked(Ops.BALLOT, id, nullifier, commitment);
    }

    /// @dev The CLOSE op as the operator writes it: request plus the final sum.
    function closeOp(uint32 id) internal view returns (bytes memory op) {
        uint8 options = info(id).optionCount;
        op = abi.encodePacked(Ops.CLOSE, id, l2Ballots[id], options);
        for (uint256 o; o < options; ++o) {
            uint256[4] memory a = l2Acc[id].length == 0 ? [uint256(0), 1, 0, 1] : l2Acc[id][o];
            op = bytes.concat(op, abi.encodePacked(a[0], a[1], a[2], a[3]));
        }
    }

    // -------------------------------------------------------------------- operator

    /// @dev Pubdata for every queued request the operator has not committed yet, in order.
    ///      CLOSE requests get their response appended. Forced ballots are accepted.
    function pendingRequestOps() internal view returns (bytes memory pubdata) {
        uint64 from = rollup.totalCommittedPriorityRequests();
        uint64 to = rollup.totalPriorityRequests();
        for (uint64 id = from; id < to; ++id) {
            pubdata = bytes.concat(pubdata, requestBytes[id]);
            if (requestType[id] == Ops.FORCED_BALLOT) pubdata = bytes.concat(pubdata, hex"01");
            if (requestType[id] == Ops.CLOSE) {
                uint32 electionId = uint32(bytes4(_slice(requestBytes[id], 1, 4)));
                bytes memory full = closeOp(electionId);
                pubdata = bytes.concat(pubdata, _slice(full, 5, full.length - 5));
            }
        }
    }

    mapping(uint64 => bytes) internal requestBytes;
    mapping(uint64 => uint8) internal requestType;

    /// @dev Record queued requests from the logs, as the operator's L1 watcher does.
    function recordRequests() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = IZkVotingRollup.PriorityRequestQueued.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(rollup) || logs[i].topics[0] != topic) continue;
            uint64 id = uint64(uint256(logs[i].topics[1]));
            requestType[id] = uint8(uint256(logs[i].topics[2]));
            (bytes memory pubdata,) = abi.decode(logs[i].data, (bytes, uint64));
            requestBytes[id] = pubdata;
        }
    }

    function commit(bytes memory pubdata) internal returns (IZkVotingRollup.StoredBatchInfo memory stored) {
        return commitWithRoot(pubdata, keccak256(abi.encode("state", ++stateNonce)));
    }

    function commitWithRoot(bytes memory pubdata, bytes32 newRoot)
        internal
        returns (IZkVotingRollup.StoredBatchInfo memory stored)
    {
        IZkVotingRollup.CommitBatchInfo memory next = IZkVotingRollup.CommitBatchInfo({
            newStateRoot: newRoot, timestamp: uint64(block.timestamp), pubdata: pubdata
        });
        uint64 before = rollup.totalCommittedPriorityRequests();
        vm.recordLogs();
        vm.prank(operator);
        rollup.commitBatch(lastBatch, next);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 commitment;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IZkVotingRollup.BatchCommitted.selector) {
                (, commitment) = abi.decode(logs[i].data, (bytes32, bytes32));
            }
        }
        (bytes32 pHash, bytes32 oHash, bytes memory onchain) = _opsDigest(pubdata, before);
        stored = IZkVotingRollup.StoredBatchInfo({
            batchNumber: lastBatch.batchNumber + 1,
            timestamp: next.timestamp,
            priorityOperations: rollup.totalCommittedPriorityRequests() - before,
            priorityOpsHash: pHash,
            onchainOpsHash: oHash,
            stateRoot: newRoot,
            commitment: commitment
        });
        lastBatch = stored;
        pendingBatches.push(stored);
        pendingOnchainOps.push(onchain);
    }

    function proof() internal pure returns (uint256[8] memory p) {
        p[0] = 1;
    }

    function verify(IZkVotingRollup.StoredBatchInfo memory b) internal {
        rollup.verifyBatch(b, proof());
    }

    /// @dev Verify and execute every pending batch.
    function settle() internal {
        for (uint256 i; i < pendingBatches.length; ++i) {
            if (pendingBatches[i].batchNumber > rollup.totalBatchesVerified()) verify(pendingBatches[i]);
        }
        rollup.executeBatches(pendingBatches, pendingOnchainOps);
        delete pendingBatches;
        delete pendingOnchainOps;
    }

    /// @dev Commit every queued request plus `extra` L2 ops in one batch, then settle it.
    function processQueue(bytes memory extra) internal {
        commit(bytes.concat(pendingRequestOps(), extra));
        settle();
    }

    /// @dev Full happy path up to an L1-closed election with `votes[i]` as voter i's choice.
    function runElection(uint256[] memory votes) internal returns (uint32 id) {
        vm.recordLogs();
        id = scheduledElection();
        uint256[] memory roll = new uint256[](votes.length);
        for (uint256 i; i < votes.length; ++i) {
            roll[i] = i + 1;
        }
        vm.prank(registrar);
        rollup.registerVoters(id, roll);
        recordRequests();
        processQueue("");

        vm.warp(info(id).startTime);
        bytes memory ballots;
        for (uint256 i; i < votes.length; ++i) {
            ballots = bytes.concat(ballots, castOnL2(id, votes[i], i));
        }
        commit(ballots);
        settle();

        vm.warp(info(id).cutoffTime);
        vm.recordLogs();
        rollup.closeElection(id);
        recordRequests();
        processQueue("");
    }

    // --------------------------------------------------------------- internal

    function _opsDigest(bytes memory pubdata, uint64 firstRequest)
        private
        view
        returns (bytes32 pHash, bytes32 oHash, bytes memory onchain)
    {
        uint256 offset;
        uint64 cursor = firstRequest;
        while (offset < pubdata.length) {
            (uint8 opType, uint256 size, uint256 requestSize) = this.sizeAtExternal(pubdata, offset);
            if (requestSize != 0) {
                bytes32 h = keccak256(_slice(pubdata, offset, requestSize));
                pHash = keccak256(abi.encode(pHash, h));
                ++cursor;
                if (opType == Ops.CLOSE) {
                    bytes memory full = _slice(pubdata, offset, size);
                    oHash = keccak256(abi.encode(oHash, keccak256(full)));
                    onchain = bytes.concat(onchain, full);
                }
            }
            offset += size;
        }
    }

    function sizeAtExternal(bytes calldata pubdata, uint256 offset)
        external
        pure
        returns (uint8 opType, uint256 size, uint256 requestSize)
    {
        return Ops.sizeAt(pubdata, offset);
    }

    function _slice(bytes memory b, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = b[from + i];
        }
    }
}
