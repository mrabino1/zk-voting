// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn128} from "./zk/Bn128.sol";
import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";

/// @title GuardianCeremony
/// @notice k-of-n Feldman DKG. Each guardian posts its own polynomial.
/// @dev `openCeremony` fixes index `i` to allowlist position `i` (1-based).
///      `postGuardian` accepts only that address. Share scalars stay off chain.
///      After every guardian has posted, the joint key is `Σ_i C_{i,0}` and
///      guardian `i`'s public share is `Σ_j Σ_t i^t · C_{j,t}`.
contract GuardianCeremony {
    uint8 public constant MIN_N = 2;
    uint8 public constant MAX_N = 16;
    bytes32 internal constant SCHNORR_DOMAIN = keccak256("GUARDIAN_SCHNORR_V1");

    error ZeroAddress();
    error UnknownElection();
    error NotTallyOperator();
    error BadCeremonyBounds();
    error CeremonyAlreadyPosted();
    error CeremonyTooLate();
    error CeremonyNotOpen();
    error PointOffCurve();
    error BadSchnorr();
    error FeldmanMismatch();
    error WrongElectionType();
    error AlreadyPosted();
    error NotGuardian();
    error BadGuardianList();

    event CeremonyOpened(uint256 indexed electionId, uint8 indexed electionType, uint8 k, uint8 n);
    event GuardianPosted(uint256 indexed electionId, uint8 indexed electionType, address indexed guardian, uint8 index);
    event CeremonyPosted(uint256 indexed electionId, uint8 indexed electionType, uint8 k, uint8 n);

    struct Deal {
        uint8 k;
        uint8 n;
        uint8 postedCount;
        uint256 jointX;
        uint256 jointY;
        bool open;
        bool posted;
    }

    IElectionFactory private immutable _factory;

    mapping(uint256 => mapping(uint8 => Deal)) private _deal;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => address))) private _guardianAt;
    mapping(uint256 => mapping(uint8 => mapping(address => uint8))) private _index;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => bool))) private _posted;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => mapping(uint8 => uint256)))) private _cx;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => mapping(uint8 => uint256)))) private _cy;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkX;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkY;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        _factory = IElectionFactory(factory_);
    }

    function factory() external view returns (address) {
        return address(_factory);
    }

    /// @notice Tally operator opens the deal before `startTime`.
    ///         `guardians[i]` is permanently index `i + 1`.
    function openCeremony(
        uint256 electionId,
        uint8 electionType,
        uint8 k,
        uint8 n,
        address[] calldata guardians
    ) external {
        if (_deal[electionId][electionType].open || _deal[electionId][electionType].posted) revert CeremonyAlreadyPosted();
        if (n < MIN_N || n > MAX_N || k < MIN_N || k > n) revert BadCeremonyBounds();
        if (guardians.length != n) revert BadGuardianList();
        ElectionParams memory p = _params(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert CeremonyTooLate();
        if (electionType != p.electionType) revert WrongElectionType();
        for (uint8 i; i < n; ++i) {
            address who = guardians[i];
            if (who == address(0)) revert ZeroAddress();
            if (_index[electionId][electionType][who] != 0) revert BadGuardianList();
            uint8 index = i + 1;
            _guardianAt[electionId][electionType][index] = who;
            _index[electionId][electionType][who] = index;
        }
        _deal[electionId][electionType] =
            Deal({k: k, n: n, postedCount: 0, jointX: 0, jointY: 0, open: true, posted: false});
        emit CeremonyOpened(electionId, electionType, k, n);
    }

    /// @notice Guardian `msg.sender` posts Feldman commitments `C_0 .. C_{k-1}`
    ///         and a Schnorr proof of possession of `C_0`. The share key is derived later.
    function postGuardian(
        uint256 electionId,
        uint8 electionType,
        uint256[] calldata cx,
        uint256[] calldata cy,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        uint8 index = _index[electionId][electionType][msg.sender];
        if (index == 0) revert NotGuardian();
        if (_posted[electionId][electionType][index]) revert AlreadyPosted();
        if (cx.length != deal.k || cy.length != deal.k) revert FeldmanMismatch();
        for (uint8 t; t < deal.k; ++t) {
            if (!Bn128.onCurve(cx[t], cy[t])) revert PointOffCurve();
            _cx[electionId][electionType][index][t] = cx[t];
            _cy[electionId][electionType][index][t] = cy[t];
        }
        uint256 e = schnorrChallenge(electionId, electionType, msg.sender, cx, cy, rX, rY);
        if (!_schnorr(cx[0], cy[0], rX, rY, z, e)) revert BadSchnorr();
        _posted[electionId][electionType][index] = true;
        unchecked {
            deal.postedCount += 1;
        }
        emit GuardianPosted(electionId, electionType, msg.sender, index);
        if (deal.postedCount == deal.n) {
            _derive(electionId, electionType, deal.n, deal.k);
            deal.posted = true;
            deal.open = false;
            emit CeremonyPosted(electionId, electionType, deal.k, deal.n);
        }
    }

    /// @notice Challenge for `g^z = R + e·C_0`, bound to every coefficient.
    function schnorrChallenge(
        uint256 electionId,
        uint8 electionType,
        address guardian,
        uint256[] calldata cx,
        uint256[] calldata cy,
        uint256 rX,
        uint256 rY
    ) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(SCHNORR_DOMAIN, electionId, electionType, guardian, cx, cy, rX, rY)))
            % Bn128.R;
    }

    function keyPosted(uint256 electionId, uint8 electionType) external view returns (bool) {
        return _deal[electionId][electionType].posted;
    }

    function threshold(uint256 electionId, uint8 electionType) external view returns (uint256) {
        return _deal[electionId][electionType].k;
    }

    function guardianCount(uint256 electionId, uint8 electionType) external view returns (uint256) {
        return _deal[electionId][electionType].n;
    }

    function jointKey(uint256 electionId, uint8 electionType) external view returns (uint256 x, uint256 y) {
        Deal storage d = _deal[electionId][electionType];
        return (d.jointX, d.jointY);
    }

    /// @notice Derived share key. `ok` is true only after the deal is complete.
    function guardianPk(uint256 electionId, uint8 electionType, address guardian)
        external
        view
        returns (uint256 x, uint256 y, bool ok)
    {
        ok = _deal[electionId][electionType].posted && _index[electionId][electionType][guardian] != 0;
        x = _pkX[electionId][electionType][guardian];
        y = _pkY[electionId][electionType][guardian];
    }

    /// @notice 1-based allowlist index. Zero if `guardian` is not on the list.
    function guardianIndex(uint256 electionId, uint8 electionType, address guardian) external view returns (uint256) {
        return _index[electionId][electionType][guardian];
    }

    function guardianAt(uint256 electionId, uint8 electionType, uint256 index) external view returns (address) {
        return _guardianAt[electionId][electionType][uint8(index)];
    }

    function _params(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
    }

    function _schnorr(uint256 c0x, uint256 c0y, uint256 rX, uint256 rY, uint256 z, uint256 e)
        internal
        view
        returns (bool)
    {
        if (!Bn128.onCurve(rX, rY)) return false;
        (bool okL, uint256 lx, uint256 ly) = Bn128.mul(1, 2, z);
        if (!okL) return false;
        (bool okE, uint256 ex, uint256 ey) = Bn128.mul(c0x, c0y, e);
        if (!okE) return false;
        (bool okR, uint256 rx, uint256 ry) = Bn128.add(rX, rY, ex, ey);
        return okR && lx == rx && ly == ry;
    }

    /// @dev `Y_i = Σ_j Σ_t (i^t mod r) · C_{j,t}` and `joint = Σ_j C_{j,0}`.
    function _derive(uint256 electionId, uint8 electionType, uint8 n, uint8 k) internal {
        uint256 jx;
        uint256 jy;
        bool jointStarted;
        for (uint8 j = 1; j <= n; ++j) {
            uint256 cx = _cx[electionId][electionType][j][0];
            uint256 cy = _cy[electionId][electionType][j][0];
            if (!jointStarted) {
                jx = cx;
                jy = cy;
                jointStarted = true;
            } else {
                (bool ok, uint256 nx, uint256 ny) = Bn128.add(jx, jy, cx, cy);
                if (!ok) revert PointOffCurve();
                jx = nx;
                jy = ny;
            }
        }
        _deal[electionId][electionType].jointX = jx;
        _deal[electionId][electionType].jointY = jy;

        for (uint8 i = 1; i <= n; ++i) {
            uint256 px;
            uint256 py;
            bool any;
            for (uint8 j = 1; j <= n; ++j) {
                uint256 pow = 1;
                for (uint8 t; t < k; ++t) {
                    (bool ok, uint256 mx, uint256 my) =
                        Bn128.mul(_cx[electionId][electionType][j][t], _cy[electionId][electionType][j][t], pow);
                    if (!ok) revert PointOffCurve();
                    if (!any) {
                        px = mx;
                        py = my;
                        any = true;
                    } else {
                        (ok, px, py) = Bn128.add(px, py, mx, my);
                        if (!ok) revert PointOffCurve();
                    }
                    pow = mulmod(pow, i, Bn128.R);
                }
            }
            address who = _guardianAt[electionId][electionType][i];
            _pkX[electionId][electionType][who] = px;
            _pkY[electionId][electionType][who] = py;
        }
    }
}
