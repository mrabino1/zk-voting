// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn128} from "./zk/Bn128.sol";
import {ElectionParams} from "./interfaces/ElectionParams.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";

/// @title GuardianCeremony
/// @notice Feldman public keys for one election type. Shares stay off chain.
/// @dev `n` is 2..16 and `k` is 2..n. The contract stores commitments only.
///      No function accepts the joint scalar or a guardian share.
contract GuardianCeremony {
    uint8 public constant MIN_N = 2;
    uint8 public constant MAX_N = 16;

    error ZeroAddress();
    error UnknownElection();
    error NotTallyOperator();
    error BadCeremonyBounds();
    error CeremonyAlreadyPosted();
    error CeremonyTooLate();
    error PointOffCurve();

    event CeremonyPosted(uint256 indexed electionId, uint8 indexed electionType, uint8 k, uint8 n);

    struct Deal {
        uint8 k;
        uint8 n;
        uint256 jointX;
        uint256 jointY;
        bool posted;
    }

    IElectionFactory private immutable _factory;

    mapping(uint256 => mapping(uint8 => Deal)) private _deal;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkX;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) private _pkY;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) private _isGuardian;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        _factory = IElectionFactory(factory_);
    }

    function factory() external view returns (address) {
        return address(_factory);
    }

    /// @notice Post guardian public keys before `startTime`. One write per election type.
    /// @dev `pks[i]` is the public key of `guardians[i]`. The caller is the tally operator.
    ///      The operator does not pass a share.
    function postCeremony(
        uint256 electionId,
        uint8 electionType,
        address[] calldata guardians,
        uint256[2][] calldata pks,
        uint8 k
    ) external {
        if (_deal[electionId][electionType].posted) revert CeremonyAlreadyPosted();
        uint256 n = guardians.length;
        if (n != pks.length || n < MIN_N || n > MAX_N) revert BadCeremonyBounds();
        if (k < MIN_N || k > n) revert BadCeremonyBounds();

        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        ElectionParams memory p = IElection(electionAddr).params();
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        if (block.timestamp >= p.startTime) revert CeremonyTooLate();

        uint256 jointX;
        uint256 jointY;
        for (uint256 i; i < n; ++i) {
            address guardian = guardians[i];
            if (guardian == address(0) || _isGuardian[electionId][electionType][guardian]) revert BadCeremonyBounds();
            uint256 x = pks[i][0];
            uint256 y = pks[i][1];
            if (!Bn128.onCurve(x, y)) revert PointOffCurve();
            if (i == 0) {
                jointX = x;
                jointY = y;
            } else {
                (bool ok, uint256 sx, uint256 sy) = Bn128.add(jointX, jointY, x, y);
                if (!ok) revert PointOffCurve();
                jointX = sx;
                jointY = sy;
            }
            _pkX[electionId][electionType][guardian] = x;
            _pkY[electionId][electionType][guardian] = y;
            _isGuardian[electionId][electionType][guardian] = true;
        }

        _deal[electionId][electionType] = Deal({k: k, n: uint8(n), jointX: jointX, jointY: jointY, posted: true});
        emit CeremonyPosted(electionId, electionType, k, uint8(n));
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
}
