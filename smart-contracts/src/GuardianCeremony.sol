// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BabyJub} from "./zk/BabyJub.sol";
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
    /// @notice After this, an absent dealer can be dropped if at least `k` posted.
    uint256 public constant COMPLAINT_WINDOW = 1 hours;
    /// @notice A dealer who does not reveal a Feldman-valid share in this window is excluded.
    uint256 public constant REVEAL_WINDOW = 1 hours;
    bytes32 internal constant SCHNORR_DOMAIN = keccak256("GUARDIAN_SCHNORR_V1");
    bytes32 internal constant SHARE_DOMAIN = keccak256("GUARDIAN_SHARE_V1");

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
    error ComplaintUnfounded();
    error ShareSignatureInvalid();
    error ComplaintWindowOpen();
    error NotEnoughGuardians();
    error ShareNotDerived();
    error ShareDisputeOpen();
    error NoShareDispute();
    error DisputeWindowOpen();

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
        uint64 openedAt;
        uint32 excluded;
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

    struct ShareClaim {
        uint8 recipient;
        uint64 openedAt;
        bool open;
    }

    /// @notice Open reveal-or-exclude dispute, keyed by the dealer.
    mapping(uint256 => mapping(uint8 => mapping(uint8 => ShareClaim))) private _claim;

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
        _deal[electionId][electionType] = Deal({
            k: k,
            n: n,
            postedCount: 0,
            jointX: 0,
            jointY: 0,
            open: true,
            posted: false,
            openedAt: uint64(block.timestamp),
            excluded: 0
        });
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
        if (index == 0 || _isExcluded(deal, index)) revert NotGuardian();
        if (_posted[electionId][electionType][index]) revert AlreadyPosted();
        if (cx.length != deal.k || cy.length != deal.k) revert FeldmanMismatch();
        for (uint8 t; t < deal.k; ++t) {
            if (!BabyJub.onCurve(cx[t], cy[t]) || !BabyJub.validPoint(cx[t], cy[t])) revert PointOffCurve();
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
        if (deal.postedCount == _liveN(deal)) _finalize(electionId, electionType);
    }

    /// @notice A guardian shows that `dealerIndex` sent a share that does not open its commitments.
    ///         The share must carry that dealer's Schnorr signature under `C_0`.
    ///         A matching share reverts. A mismatch drops that dealer. The joint key is not derived here.
    function complain(
        uint256 electionId,
        uint8 electionType,
        uint8 dealerIndex,
        uint256 share,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        uint8 mine = _index[electionId][electionType][msg.sender];
        if (mine == 0 || _isExcluded(deal, mine)) revert NotGuardian();
        if (dealerIndex == 0 || dealerIndex > deal.n || _isExcluded(deal, dealerIndex)) revert NotGuardian();
        if (!_posted[electionId][electionType][dealerIndex]) revert NotGuardian();
        uint256 e = shareChallenge(electionId, electionType, dealerIndex, mine, share, rX, rY);
        if (!_schnorr(
                _cx[electionId][electionType][dealerIndex][0],
                _cy[electionId][electionType][dealerIndex][0],
                rX,
                rY,
                z,
                e
            )) revert ShareSignatureInvalid();
        (uint256 ex, uint256 ey) = _eval(electionId, electionType, dealerIndex, mine, deal.k);
        (uint256 sx, uint256 sy) = BabyJub.mulBase(share);
        if (sx == ex && sy == ey) revert ComplaintUnfounded();
        _exclude(electionId, electionType, dealerIndex);
    }

    /// @notice Challenge for the dealer's signature on one share, bound to both indices.
    function shareChallenge(
        uint256 electionId,
        uint8 electionType,
        uint8 dealerIndex,
        uint8 recipientIndex,
        uint256 share,
        uint256 rX,
        uint256 rY
    ) public view returns (uint256) {
        return uint256(
            keccak256(
                abi.encode(
                    SHARE_DOMAIN,
                    block.chainid,
                    address(this),
                    electionId,
                    electionType,
                    dealerIndex,
                    recipientIndex,
                    share,
                    rX,
                    rY
                )
            )
        ) % BabyJub.ORDER;
    }

    /// @notice Recipient opens a dispute. The dealer must reveal the Feldman share or be excluded.
    ///         An unsigned off-chain share is this path: there is no signature to check, so silence excludes.
    function openShareDispute(uint256 electionId, uint8 electionType, uint8 dealerIndex) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        uint8 mine = _index[electionId][electionType][msg.sender];
        if (mine == 0 || _isExcluded(deal, mine)) revert NotGuardian();
        if (dealerIndex == 0 || dealerIndex > deal.n || _isExcluded(deal, dealerIndex)) revert NotGuardian();
        if (!_posted[electionId][electionType][dealerIndex]) revert NotGuardian();
        ShareClaim storage claim = _claim[electionId][electionType][dealerIndex];
        if (claim.open) revert ShareDisputeOpen();
        claim.recipient = mine;
        claim.openedAt = uint64(block.timestamp);
        claim.open = true;
    }

    /// @notice Dealer reveals the share for the open dispute. A matching share closes it.
    ///         A share that misses the Feldman commitments excludes the dealer.
    function revealShare(uint256 electionId, uint8 electionType, uint256 share) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        uint8 dealer = _index[electionId][electionType][msg.sender];
        if (dealer == 0 || _isExcluded(deal, dealer)) revert NotGuardian();
        ShareClaim storage claim = _claim[electionId][electionType][dealer];
        if (!claim.open) revert NoShareDispute();
        claim.open = false;
        (uint256 ex, uint256 ey) = _eval(electionId, electionType, dealer, claim.recipient, deal.k);
        (uint256 sx, uint256 sy) = BabyJub.mulBase(share);
        if (sx != ex || sy != ey) _exclude(electionId, electionType, dealer);
    }

    /// @notice Exclude a dealer who never revealed. Covers an unsigned or withheld share.
    function expireShareDispute(uint256 electionId, uint8 electionType, uint8 dealerIndex) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        ShareClaim storage claim = _claim[electionId][electionType][dealerIndex];
        if (!claim.open) revert NoShareDispute();
        if (block.timestamp < uint256(claim.openedAt) + REVEAL_WINDOW) revert DisputeWindowOpen();
        claim.open = false;
        _exclude(electionId, electionType, dealerIndex);
    }

    /// @notice After the complaint window, finalize from the guardians who posted when at least `k` remain.
    function dropAbsent(uint256 electionId, uint8 electionType) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.open || deal.posted) revert CeremonyNotOpen();
        if (block.timestamp < uint256(deal.openedAt) + COMPLAINT_WINDOW) revert ComplaintWindowOpen();
        if (deal.postedCount < deal.k) revert NotEnoughGuardians();
        _finalize(electionId, electionType);
    }

    /// @notice One guardian public key. O(n·k) scalar multiplications, one guardian per call.
    function deriveShare(uint256 electionId, uint8 electionType, uint8 index) external {
        Deal storage deal = _deal[electionId][electionType];
        if (!deal.posted) revert CeremonyNotOpen();
        if (index == 0 || index > deal.n || _isExcluded(deal, index)) revert NotGuardian();
        address who = _guardianAt[electionId][electionType][index];
        (uint256 px, uint256 py) = _sharePoint(electionId, electionType, index, deal.n, deal.k, deal.excluded);
        _pkX[electionId][electionType][who] = px;
        _pkY[electionId][electionType][who] = py;
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
            % BabyJub.ORDER;
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
        Deal storage deal = _deal[electionId][electionType];
        uint8 index = _index[electionId][electionType][guardian];
        x = _pkX[electionId][electionType][guardian];
        y = _pkY[electionId][electionType][guardian];
        ok = deal.posted && index != 0 && !_isExcluded(deal, index) && (x != 0 || y != 0);
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
        if (!BabyJub.onCurve(rX, rY)) return false;
        (uint256 lx, uint256 ly) = BabyJub.mulBase(z);
        (uint256 ex, uint256 ey) = BabyJub.mul(c0x, c0y, e);
        (uint256 rx, uint256 ry) = BabyJub.add(rX, rY, ex, ey);
        return lx == rx && ly == ry;
    }

    function _isExcluded(Deal storage deal, uint8 index) internal view returns (bool) {
        return (deal.excluded & (uint32(1) << index)) != 0;
    }

    function _liveN(Deal storage deal) internal view returns (uint8 n) {
        for (uint8 i = 1; i <= deal.n; ++i) {
            if (!_isExcluded(deal, i)) n += 1;
        }
    }

    /// @dev Joint key only. Each guardian key is `deriveShare`, so 16-of-16 does not do n²k multiplications.
    function _finalize(uint256 electionId, uint8 electionType) internal {
        Deal storage deal = _deal[electionId][electionType];
        uint256 jx;
        uint256 jy;
        bool started;
        for (uint8 j = 1; j <= deal.n; ++j) {
            if (_isExcluded(deal, j) || !_posted[electionId][electionType][j]) continue;
            uint256 cx = _cx[electionId][electionType][j][0];
            uint256 cy = _cy[electionId][electionType][j][0];
            if (!started) {
                jx = cx;
                jy = cy;
                started = true;
            } else {
                (jx, jy) = BabyJub.add(jx, jy, cx, cy);
            }
        }
        if (!started || deal.postedCount < deal.k) revert NotEnoughGuardians();
        deal.jointX = jx;
        deal.jointY = jy;
        deal.posted = true;
        deal.open = false;
        emit CeremonyPosted(electionId, electionType, deal.k, deal.n);
    }

    function _exclude(uint256 electionId, uint8 electionType, uint8 dealerIndex) internal {
        Deal storage deal = _deal[electionId][electionType];
        deal.excluded |= uint32(1) << dealerIndex;
        if (_posted[electionId][electionType][dealerIndex]) {
            _posted[electionId][electionType][dealerIndex] = false;
            deal.postedCount -= 1;
        }
    }

    /// @dev g^share == Σ_t index^t · C_t for one dealer.
    function _eval(uint256 electionId, uint8 electionType, uint8 dealer, uint8 at, uint8 k)
        internal
        view
        returns (uint256 px, uint256 py)
    {
        uint256 pow = 1;
        bool any;
        for (uint8 t; t < k; ++t) {
            (uint256 mx, uint256 my) =
                BabyJub.mul(_cx[electionId][electionType][dealer][t], _cy[electionId][electionType][dealer][t], pow);
            if (!any) {
                px = mx;
                py = my;
                any = true;
            } else {
                (px, py) = BabyJub.add(px, py, mx, my);
            }
            pow = mulmod(pow, at, BabyJub.ORDER);
        }
    }

    function _sharePoint(
        uint256 electionId,
        uint8 electionType,
        uint8 index,
        uint8 n,
        uint8 k,
        uint32 excluded
    ) internal view returns (uint256 px, uint256 py) {
        bool any;
        for (uint8 j = 1; j <= n; ++j) {
            if ((excluded & (uint32(1) << j)) != 0 || !_posted[electionId][electionType][j]) continue;
            uint256 pow = 1;
            for (uint8 t; t < k; ++t) {
                (uint256 mx, uint256 my) =
                    BabyJub.mul(_cx[electionId][electionType][j][t], _cy[electionId][electionType][j][t], pow);
                if (!any) {
                    px = mx;
                    py = my;
                    any = true;
                } else {
                    (px, py) = BabyJub.add(px, py, mx, my);
                }
                pow = mulmod(pow, index, BabyJub.ORDER);
            }
        }
    }
}
