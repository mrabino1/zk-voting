// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn128} from "./zk/Bn128.sol";
import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";

/// @title GuardianCeremony
/// @notice Feldman C_0 and per-guardian share keys. Shares stay off chain.
/// @dev `n` is 2..16 and `k` is 2..n. Each guardian posts the same Feldman `C_0`
///      and a Schnorr proof that they hold the discrete log of their share key
///      `g^{s_i}`. The joint encryption key is `C_0`, not the sum of the share keys.
///      No function accepts the joint scalar or a guardian share.
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
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkX;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkY;
    mapping(uint256 => mapping(uint8 => mapping(address => uint8))) private _index;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) private _isGuardian;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        _factory = IElectionFactory(factory_);
    }

    function factory() external view returns (address) {
        return address(_factory);
    }

    /// @notice Tally operator opens the deal before `startTime`.
    ///         `electionType` must be the election's type. Guardians post their own keys.
    function openCeremony(uint256 electionId, uint8 electionType, uint8 k, uint8 n) external {
        if (_deal[electionId][electionType].open || _deal[electionId][electionType].posted) revert CeremonyAlreadyPosted();
        if (n < MIN_N || n > MAX_N || k < MIN_N || k > n) revert BadCeremonyBounds();
        ElectionParams memory p = _params(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert CeremonyTooLate();
        if (electionType != p.electionType) revert WrongElectionType();
        _deal[electionId][electionType] = Deal({k: k, n: n, postedCount: 0, jointX: 0, jointY: 0, open: true, posted: false});
        emit CeremonyOpened(electionId, electionType, k, n);
    }

    /// @notice Guardian posts Feldman `C_0` and `g^{s_i}` with a Schnorr proof of possession of `s_i`.
    function postGuardian(
        uint256 electionId,
        uint8 electionType,
        uint256 pkX,
        uint256 pkY,
        uint256 c0X,
        uint256 c0Y,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        if (_isGuardian[electionId][electionType][msg.sender]) revert AlreadyPosted();
        if (!Bn128.onCurve(c0X, c0Y)) revert PointOffCurve();
        if (deal.postedCount == 0) {
            deal.jointX = c0X;
            deal.jointY = c0Y;
        } else if (deal.jointX != c0X || deal.jointY != c0Y) {
            revert FeldmanMismatch();
        }
        if (!_schnorr(electionId, electionType, pkX, pkY, rX, rY, z)) revert BadSchnorr();
        uint8 index;
        unchecked {
            index = deal.postedCount + 1;
            deal.postedCount = index;
        }
        _pkX[electionId][electionType][msg.sender] = pkX;
        _pkY[electionId][electionType][msg.sender] = pkY;
        _index[electionId][electionType][msg.sender] = index;
        _isGuardian[electionId][electionType][msg.sender] = true;
        emit GuardianPosted(electionId, electionType, msg.sender, index);
        if (deal.postedCount == deal.n) {
            deal.posted = true;
            deal.open = false;
            emit CeremonyPosted(electionId, electionType, deal.k, deal.n);
        }
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

    function guardianPk(uint256 electionId, uint8 electionType, address guardian)
        external
        view
        returns (uint256 x, uint256 y, bool ok)
    {
        ok = _isGuardian[electionId][electionType][guardian];
        x = _pkX[electionId][electionType][guardian];
        y = _pkY[electionId][electionType][guardian];
    }

    /// @notice 1-based Shamir index, in the order the guardians posted.
    function guardianIndex(uint256 electionId, uint8 electionType, address guardian) external view returns (uint256) {
        return _index[electionId][electionType][guardian];
    }

    function _params(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
    }

    /// @dev `g^z = R + e·pk` with `e` bound to this election, type, and guardian.
    function _schnorr(
        uint256 electionId,
        uint8 electionType,
        uint256 pkX,
        uint256 pkY,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) internal view returns (bool) {
        if (!Bn128.onCurve(pkX, pkY) || !Bn128.onCurve(rX, rY)) return false;
        uint256 e = uint256(keccak256(abi.encode(SCHNORR_DOMAIN, electionId, electionType, msg.sender, pkX, pkY, rX, rY)))
            % Bn128.R;
        (bool okL, uint256 lx, uint256 ly) = Bn128.mul(1, 2, z);
        if (!okL) return false;
        (bool okE, uint256 ex, uint256 ey) = Bn128.mul(pkX, pkY, e);
        if (!okE) return false;
        (bool okR, uint256 rx, uint256 ry) = Bn128.add(rX, rY, ex, ey);
        return okR && lx == rx && ly == ry;
    }
}
