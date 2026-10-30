// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn254} from "./Bn254.sol";
import {WesolowskiTimeLock} from "./WesolowskiTimeLock.sol";
import {ElectionParams, ElectionType} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";

/// @title SealedVoteKey
/// @notice k-of-n tally key for a VOTE. Each guardian deals a Feldman polynomial
///         on BN254. The contract reconstructs the scalar only after cutoff and
///         only after the time-lock opening has been checked.
/// @dev Assumptions (see `docs/sealed-vote-hold.md`):
///      - Honest threshold. Any `k` guardians who kept their scalars can
///        interpolate the key off chain as soon as dealing finishes, if they
///        also have the ciphertexts. The contract does not give them those
///        scalars, and it will not store a submitted share before cutoff.
///      - The operator is not a guardian and has no share. The operator alone
///        cannot decrypt.
///      - Fewer than `k` shares do not determine the scalar.
///      - The time-lock is a second gate. It does not hide a share a guardian
///        already holds. It stops this contract from accepting shares or
///        releasing the scalar until the Wesolowski opening is valid.
///      - A guardian who sends `submitShare` before cutoff publishes the share
///        in reverted calldata. Do not send it early.
///      - A guardian who deals a point they cannot open can block release.
///        The operator may `reset` before `startTime` and deal again.
contract SealedVoteKey {
    /// @dev BN254 scalar field.
    uint256 internal constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 public constant MAX_GUARDIANS = 16;

    IElectionFactory public immutable factory;
    WesolowskiTimeLock public immutable timeLock;

    struct Ceremony {
        uint64 k;
        uint64 n;
        bool complete;
        bool released;
        uint256 scalar;
    }

    mapping(uint256 => Ceremony) private _ceremony;
    mapping(uint256 => address[]) private _guardians;
    mapping(uint256 => mapping(address => uint256)) private _index; // 1-based
    mapping(uint256 => mapping(address => bool)) private _dealt;
    mapping(uint256 => mapping(uint256 => uint256)) private _jx;
    mapping(uint256 => mapping(uint256 => uint256)) private _jy;
    mapping(uint256 => mapping(address => bool)) private _shareIn;
    mapping(uint256 => mapping(address => uint256)) private _share;
    mapping(uint256 => uint256) private _shareCount;

    error UnknownElection();
    error NotVote();
    error NotTallyOperator();
    error NotGuardian();
    error SetupClosed();
    error BadCeremony();
    error DealMissing();
    error AlreadyDealt();
    error KeyMismatch();
    error TooEarly(uint256 electionId);
    error TimeLockClosed(uint256 electionId);
    error BadShare();
    error AlreadyReleased();
    error NeedMoreShares(uint256 have, uint256 need);
    error DuplicateGuardian();

    event CeremonyConfigured(uint256 indexed electionId, uint64 k, uint64 n);
    event DealSubmitted(uint256 indexed electionId, address indexed guardian);
    event CeremonyFinalized(uint256 indexed electionId, uint256 keyX, uint256 keyY);
    event CeremonyReset(uint256 indexed electionId);
    /// @notice Guardian index only. The share itself is not logged.
    event ShareAccepted(uint256 indexed electionId, uint256 index);
    event KeyReleased(uint256 indexed electionId);

    constructor(address factory_, address timeLock_) {
        if (factory_ == address(0) || timeLock_ == address(0)) revert UnknownElection();
        factory = IElectionFactory(factory_);
        timeLock = WesolowskiTimeLock(timeLock_);
    }

    /// @notice Guardian list and threshold. Before start. Not a ballot.
    function configure(uint256 electionId, uint64 k, address[] calldata guardians) external {
        ElectionParams memory p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert SetupClosed();
        if (_ceremony[electionId].complete) revert SetupClosed();
        uint256 oldK = _ceremony[electionId].k;
        for (uint256 j; j < oldK; ++j) {
            _jx[electionId][j] = 0;
            _jy[electionId][j] = 0;
        }
        uint256 n = guardians.length;
        if (k < 2 || n < k || n > MAX_GUARDIANS) revert BadCeremony();
        _clearGuardians(electionId);
        for (uint256 i; i < n; ++i) {
            address g = guardians[i];
            if (g == address(0) || _index[electionId][g] != 0) revert DuplicateGuardian();
            _guardians[electionId].push(g);
            _index[electionId][g] = i + 1;
        }
        _ceremony[electionId].k = k;
        _ceremony[electionId].n = uint64(n);
        emit CeremonyConfigured(electionId, k, uint64(n));
    }

    /// @notice Coefficient commitments `a_j * G`, length `k`. Added into the joint key.
    function submitDeal(uint256 electionId, uint256[] calldata comX, uint256[] calldata comY) external {
        Ceremony storage c = _ceremony[electionId];
        if (c.k == 0 || c.complete) revert BadCeremony();
        ElectionParams memory p = _voteParams(electionId);
        if (block.timestamp >= p.startTime) revert SetupClosed();
        uint256 idx = _index[electionId][msg.sender];
        if (idx == 0) revert NotGuardian();
        if (_dealt[electionId][msg.sender]) revert AlreadyDealt();
        if (comX.length != c.k || comY.length != c.k) revert BadCeremony();
        for (uint256 j; j < c.k; ++j) {
            if (!Bn254.isOnCurve(comX[j], comY[j])) revert BadCeremony();
            (uint256 x, uint256 y) = Bn254.add(_jx[electionId][j], _jy[electionId][j], comX[j], comY[j]);
            _jx[electionId][j] = x;
            _jy[electionId][j] = y;
        }
        if (_jx[electionId][0] == 0 && _jy[electionId][0] == 0) revert BadCeremony();
        _dealt[electionId][msg.sender] = true;
        emit DealSubmitted(electionId, msg.sender);
    }

    /// @notice Lock the joint public key. If the election params carry a key, it must match.
    function finalize(uint256 electionId) external {
        Ceremony storage c = _ceremony[electionId];
        ElectionParams memory p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert SetupClosed();
        if (c.k == 0 || c.complete) revert BadCeremony();
        address[] storage gs = _guardians[electionId];
        for (uint256 i; i < gs.length; ++i) {
            if (!_dealt[electionId][gs[i]]) revert DealMissing();
        }
        uint256 kx = _jx[electionId][0];
        uint256 ky = _jy[electionId][0];
        if (p.tallyPubKeyX != bytes32(0) || p.tallyPubKeyY != bytes32(0)) {
            if (uint256(p.tallyPubKeyX) != kx || uint256(p.tallyPubKeyY) != ky) revert KeyMismatch();
        }
        c.complete = true;
        emit CeremonyFinalized(electionId, kx, ky);
    }

    /// @notice Drop deals before start so a bad guardian can be replaced.
    function reset(uint256 electionId) external {
        ElectionParams memory p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert SetupClosed();
        Ceremony storage c = _ceremony[electionId];
        uint256 k = c.k;
        for (uint256 j; j < k; ++j) {
            _jx[electionId][j] = 0;
            _jy[electionId][j] = 0;
        }
        _clearGuardians(electionId);
        delete _ceremony[electionId];
        emit CeremonyReset(electionId);
    }

    /// @notice Guardian reveals one Shamir share. Refuses before cutoff and
    ///         before the time-lock opening, and writes nothing on that revert
    ///         because the checks run in the external function before the lock.
    function submitShare(uint256 electionId, uint256 share) external {
        _requireReleaseWindow(electionId);
        _acceptShare(electionId, share);
    }

    /// @notice Interpolate the scalar from `k` accepted shares. After cutoff only.
    function release(uint256 electionId) external {
        _requireReleaseWindow(electionId);
        _release(electionId);
    }

    function publicKey(uint256 electionId) external view returns (uint256 x, uint256 y) {
        if (!_ceremony[electionId].complete) return (0, 0);
        return (_jx[electionId][0], _jy[electionId][0]);
    }

    function isComplete(uint256 electionId) external view returns (bool) {
        return _ceremony[electionId].complete;
    }

    function isReleased(uint256 electionId) external view returns (bool) {
        return _ceremony[electionId].released;
    }

    /// @notice Zero until `release`. The scalar is the tally private key.
    function releasedScalar(uint256 electionId) external view returns (uint256) {
        Ceremony storage c = _ceremony[electionId];
        if (!c.released) return 0;
        return c.scalar;
    }

    function threshold(uint256 electionId) external view returns (uint64 k, uint64 n) {
        Ceremony storage c = _ceremony[electionId];
        return (c.k, c.n);
    }

    function shareCount(uint256 electionId) external view returns (uint256) {
        return _shareCount[electionId];
    }

    /// @notice Test and app helper: `scalar * G`.
    function scalarMulG(uint256 scalar) external view returns (uint256 x, uint256 y) {
        return Bn254.mulG(scalar);
    }

    function _acceptShare(uint256 electionId, uint256 share) internal {
        Ceremony storage c = _ceremony[electionId];
        if (!c.complete || c.released) revert BadCeremony();
        uint256 idx = _index[electionId][msg.sender];
        if (idx == 0) revert NotGuardian();
        if (_shareIn[electionId][msg.sender]) revert AlreadyDealt();
        if (share == 0 || share >= R) revert BadShare();
        (uint256 sx, uint256 sy) = Bn254.mulG(share);
        (uint256 ex, uint256 ey) = _expected(electionId, idx, c.k);
        if (sx != ex || sy != ey) revert BadShare();
        _shareIn[electionId][msg.sender] = true;
        _share[electionId][msg.sender] = share;
        unchecked {
            _shareCount[electionId] += 1;
        }
        emit ShareAccepted(electionId, idx);
    }

    function _release(uint256 electionId) internal {
        Ceremony storage c = _ceremony[electionId];
        if (!c.complete || c.released) revert AlreadyReleased();
        if (_shareCount[electionId] < c.k) revert NeedMoreShares(_shareCount[electionId], c.k);
        uint256[] memory xs = new uint256[](c.k);
        uint256[] memory ys = new uint256[](c.k);
        uint256 filled;
        address[] storage gs = _guardians[electionId];
        for (uint256 i; i < gs.length && filled < c.k; ++i) {
            if (!_shareIn[electionId][gs[i]]) continue;
            xs[filled] = i + 1;
            ys[filled] = _share[electionId][gs[i]];
            unchecked {
                ++filled;
            }
        }
        c.scalar = _lagrange(xs, ys);
        c.released = true;
        emit KeyReleased(electionId);
    }

    function _expected(uint256 electionId, uint256 idx, uint64 k) internal view returns (uint256 x, uint256 y) {
        uint256 pow = 1;
        for (uint256 j; j < k; ++j) {
            (uint256 tx_, uint256 ty) = Bn254.mul(_jx[electionId][j], _jy[electionId][j], pow);
            (x, y) = Bn254.add(x, y, tx_, ty);
            pow = mulmod(pow, idx, R);
        }
    }

    function _lagrange(uint256[] memory xs, uint256[] memory ys) internal pure returns (uint256 secret) {
        uint256 k = xs.length;
        for (uint256 i; i < k; ++i) {
            uint256 num = 1;
            uint256 den = 1;
            for (uint256 j; j < k; ++j) {
                if (i == j) continue;
                num = mulmod(num, _sub(0, xs[j]), R);
                den = mulmod(den, _sub(xs[i], xs[j]), R);
            }
            uint256 lam = mulmod(num, _pow(den, R - 2, R), R);
            secret = addmod(secret, mulmod(ys[i], lam, R), R);
        }
    }

    function _requireReleaseWindow(uint256 electionId) internal view {
        ElectionParams memory p = _voteParams(electionId);
        if (block.timestamp < p.cutoffTime) revert TooEarly(electionId);
        if (!timeLock.isOpen(electionId)) revert TimeLockClosed(electionId);
        if (!_ceremony[electionId].complete) revert BadCeremony();
    }

    function _clearGuardians(uint256 electionId) internal {
        address[] storage gs = _guardians[electionId];
        for (uint256 i; i < gs.length; ++i) {
            _index[electionId][gs[i]] = 0;
            _dealt[electionId][gs[i]] = false;
        }
        delete _guardians[electionId];
    }

    function _voteParams(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
        if (p.electionType != ElectionType.VOTE) revert NotVote();
    }

    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return addmod(a, R - (b % R), R);
    }

    function _pow(uint256 base, uint256 exponent, uint256 modulus) internal pure returns (uint256 result) {
        result = 1;
        base %= modulus;
        while (exponent != 0) {
            if (exponent & 1 == 1) result = mulmod(result, base, modulus);
            base = mulmod(base, base, modulus);
            exponent >>= 1;
        }
    }
}
