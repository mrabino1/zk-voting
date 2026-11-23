// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BabyJub} from "./BabyJub.sol";

/// @title Guardians
/// @notice k-of-n Feldman key ceremony and threshold decryption on Baby Jubjub.
/// @dev Linked as an external library. Its storage is the rollup's, since it runs by
///      delegatecall, and so `address(this)` in every challenge is the rollup.
///
///      Guardian `i` (1-based) deals a polynomial `f_i` of degree `k − 1` and posts
///      `C_{i,t} = a_{i,t} · G` with a Schnorr proof of `a_{i,0}`. It sends the share
///      `f_i(j)` to guardian `j` off chain, signed under `C_{i,0}`. A recipient can show a
///      signed bad share (`complain`) or demand that the dealer reveal one (`openDispute`).
///      A dealer who cheats or stays silent is excluded. The joint key is
///      `Σ C_{i,0}` over dealers who committed and were not excluded. Guardian `j`'s public
///      share is `PK_j = Σ_i Σ_t j^t · C_{i,t}`.
///
///      Decryption: each guardian posts `D_{j,o} = s_j · c1_o` per option with a
///      Chaum-Pedersen proof. For `k` guardians, `c2_o − Σ λ_j D_{j,o} = m_o · G`.
library Guardians {
    uint8 internal constant MIN_GUARDIANS = 1;
    uint8 internal constant MAX_GUARDIANS = 16;

    /// @notice Quiet period after the last commitment, for complaints and disputes.
    uint256 internal constant COMPLAINT_WINDOW = 1 hours;
    /// @notice Time a dealer has to reveal a disputed share.
    uint256 internal constant REVEAL_WINDOW = 1 hours;
    /// @notice After this, the ceremony may finish without the guardians who never committed.
    uint256 internal constant KEYGEN_TIMEOUT = 1 days;

    bytes32 internal constant SCHNORR_DOMAIN = keccak256("zk-voting.guardian.schnorr.v1");
    bytes32 internal constant SHARE_DOMAIN = keccak256("zk-voting.guardian.share.v1");
    bytes32 internal constant DECRYPT_DOMAIN = keccak256("zk-voting.guardian.decrypt.v1");

    struct Dispute {
        uint8 recipient;
        uint64 openedAt;
    }

    struct Committee {
        uint8 n;
        uint8 k;
        uint8 committed;
        uint64 openedAt;
        uint64 lastCommitAt;
        /// @dev Bit `i` set: dealer `i` was excluded.
        uint32 excluded;
        /// @dev Bit `i` set: dealer `i` has an open dispute.
        uint32 disputed;
        /// @dev Bit `i` set: guardian `i` posted decryption shares.
        uint32 sharesPosted;
        mapping(uint8 => address) member;
        mapping(address => uint8) indexOf;
        mapping(uint8 => uint256[]) cx;
        mapping(uint8 => uint256[]) cy;
        mapping(uint8 => Dispute) dispute;
        mapping(uint8 => uint256[2]) pk;
        /// @dev guardian → option → `D`.
        mapping(uint8 => mapping(uint256 => uint256[2])) share;
    }

    struct Share {
        uint256 dX;
        uint256 dY;
        uint256 aX;
        uint256 aY;
        uint256 bX;
        uint256 bY;
        uint256 z;
    }

    error BadCommittee();
    error NotMember();
    error AlreadyCommitted();
    error BadCommitments();
    error BadPoint();
    error BadSchnorr();
    error ComplaintUnfounded();
    error DisputeOpen();
    error NoDispute();
    error TooEarly();
    error NotEnoughGuardians();
    error BadShares();
    error SharesAlreadyPosted();
    error BadSubset();

    // ------------------------------------------------------------ ceremony

    function open(Committee storage c, address[] calldata members, uint8 k) internal {
        uint256 n = members.length;
        if (n < MIN_GUARDIANS || n > MAX_GUARDIANS || k == 0 || k > n) revert BadCommittee();
        for (uint256 i; i < n; ++i) {
            address who = members[i];
            if (who == address(0) || c.indexOf[who] != 0) revert BadCommittee();
            uint8 index = uint8(i + 1);
            c.member[index] = who;
            c.indexOf[who] = index;
        }
        c.n = uint8(n);
        c.k = k;
        c.openedAt = uint64(block.timestamp);
    }

    /// @notice Post `C_0 … C_{k−1}` and a Schnorr proof `z·G = R + e·C_0`.
    function commit(
        Committee storage c,
        uint32 electionId,
        address sender,
        uint256[] calldata cx,
        uint256[] calldata cy,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) external returns (uint8 index) {
        index = _liveMember(c, sender);
        if (c.cx[index].length != 0) revert AlreadyCommitted();
        if (cx.length != c.k || cy.length != c.k) revert BadCommitments();
        for (uint256 t; t < cx.length; ++t) {
            if (!BabyJub.inSubgroup(cx[t], cy[t])) revert BadPoint();
        }
        uint256 e = schnorrChallenge(electionId, index, cx, cy, rX, rY);
        if (!_schnorr(cx[0], cy[0], rX, rY, z, e)) revert BadSchnorr();
        c.cx[index] = cx;
        c.cy[index] = cy;
        c.committed += 1;
        c.lastCommitAt = uint64(block.timestamp);
    }

    /// @notice A recipient shows a share signed by `dealer` that does not open its commitments.
    ///         The dealer is excluded.
    function complain(
        Committee storage c,
        uint32 electionId,
        address sender,
        uint8 dealer,
        uint256 share,
        uint256 rX,
        uint256 rY,
        uint256 z
    ) external {
        uint8 me = _liveMember(c, sender);
        _requireCommittedDealer(c, dealer);
        uint256 e = shareChallenge(electionId, dealer, me, share, rX, rY);
        if (!_schnorr(c.cx[dealer][0], c.cy[dealer][0], rX, rY, z, e)) revert BadSchnorr();
        if (_opens(c, dealer, me, share)) revert ComplaintUnfounded();
        _exclude(c, dealer);
    }

    /// @notice A recipient who got no share, or an unsigned one, makes the dealer reveal it.
    function openDispute(Committee storage c, address sender, uint8 dealer) external returns (uint8 me) {
        me = _liveMember(c, sender);
        _requireCommittedDealer(c, dealer);
        uint32 bit = uint32(1) << dealer;
        if (c.disputed & bit != 0) revert DisputeOpen();
        c.disputed |= bit;
        c.dispute[dealer] = Dispute({recipient: me, openedAt: uint64(block.timestamp)});
    }

    /// @notice The dealer reveals the disputed share. Returns true when it fails to open the
    ///         commitments and the dealer was excluded.
    function revealShare(Committee storage c, address sender, uint256 share)
        external
        returns (uint8 dealer, bool excluded)
    {
        dealer = _liveMember(c, sender);
        uint32 bit = uint32(1) << dealer;
        if (c.disputed & bit == 0) revert NoDispute();
        c.disputed &= ~bit;
        excluded = !_opens(c, dealer, c.dispute[dealer].recipient, share);
        if (excluded) _exclude(c, dealer);
    }

    /// @notice Exclude a dealer who did not reveal in time.
    function expireDispute(Committee storage c, uint8 dealer) external {
        uint32 bit = uint32(1) << dealer;
        if (dealer == 0 || dealer > c.n || c.disputed & bit == 0) revert NoDispute();
        if (block.timestamp < uint256(c.dispute[dealer].openedAt) + REVEAL_WINDOW) revert TooEarly();
        c.disputed &= ~bit;
        _exclude(c, dealer);
    }

    /// @notice Joint key from the dealers in good standing. Needs no open dispute, at least `k`
    ///         dealers, and either everyone committed a complaint window ago or the timeout passed.
    function finalize(Committee storage c) external view returns (uint256 x, uint256 y) {
        if (c.disputed != 0) revert DisputeOpen();
        if (c.committed < c.k) revert NotEnoughGuardians();
        bool everyone = c.committed == _liveCount(c);
        bool quiet = block.timestamp >= uint256(c.lastCommitAt) + COMPLAINT_WINDOW;
        bool timedOut = block.timestamp >= uint256(c.openedAt) + KEYGEN_TIMEOUT;
        if (!(everyone && quiet) && !timedOut) revert TooEarly();
        x = 0;
        y = 1;
        for (uint8 i = 1; i <= c.n; ++i) {
            if (!_inGoodStanding(c, i)) continue;
            (x, y) = BabyJub.add(x, y, c.cx[i][0], c.cy[i][0]);
        }
    }

    // ---------------------------------------------------------- decryption

    /// @notice Verify and store one guardian's shares for every option of the final accumulator.
    ///         `c1` holds `(x, y)` per option.
    function postShares(
        Committee storage c,
        uint32 electionId,
        address sender,
        uint256[2][] memory c1,
        Share[] calldata shares
    ) external returns (uint8 index) {
        index = c.indexOf[sender];
        if (index == 0 || c.excluded & (uint32(1) << index) != 0) revert NotMember();
        if (c.sharesPosted & (uint32(1) << index) != 0) revert SharesAlreadyPosted();
        if (shares.length != c1.length) revert BadShares();
        (uint256 pkX, uint256 pkY) = publicShare(c, index);
        c.pk[index] = [pkX, pkY];
        for (uint256 o; o < shares.length; ++o) {
            Share calldata s = shares[o];
            if (!_chaumPedersen(electionId, o, index, pkX, pkY, c1[o][0], c1[o][1], s)) revert BadShares();
            c.share[index][o] = [s.dX, s.dY];
        }
        c.sharesPosted |= uint32(1) << index;
    }

    /// @notice `m · G = c2 − Σ λ_j D_j` over the `k` guardians in `subset`.
    function combine(Committee storage c, uint256 option, uint256 c2x, uint256 c2y, uint8[] calldata subset)
        external
        view
        returns (uint256 mx, uint256 my)
    {
        uint256 k = subset.length;
        if (k != c.k) revert BadSubset();
        for (uint256 i; i < k; ++i) {
            uint8 g = subset[i];
            if (g == 0 || g > c.n || c.sharesPosted & (uint32(1) << g) == 0) revert BadSubset();
            for (uint256 j; j < i; ++j) {
                if (subset[j] == g) revert BadSubset();
            }
        }
        (mx, my) = (c2x, c2y);
        for (uint256 i; i < k; ++i) {
            uint256[2] storage d = c.share[subset[i]][option];
            (uint256 sx, uint256 sy) = BabyJub.mul(d[0], d[1], lagrangeAtZero(subset, i));
            (mx, my) = BabyJub.sub(mx, my, sx, sy);
        }
    }

    /// @notice `λ_i(0) = Π_{j≠i} x_j / (x_j − x_i) mod ORDER`, with `x` the 1-based indexes.
    function lagrangeAtZero(uint8[] calldata xs, uint256 i) internal pure returns (uint256) {
        uint256 num = 1;
        uint256 den = 1;
        uint256 n = BabyJub.ORDER;
        uint256 xi = xs[i];
        for (uint256 j; j < xs.length; ++j) {
            if (j == i) continue;
            uint256 xj = xs[j];
            num = mulmod(num, xj, n);
            den = mulmod(den, addmod(xj, n - xi, n), n);
        }
        return mulmod(num, BabyJub.invMod(den, n), n);
    }

    /// @notice `PK_j = Σ_i Σ_t j^t · C_{i,t}` over dealers in good standing. Cached the first
    ///         time guardian `j` posts shares, which is after the key is final.
    function publicShare(Committee storage c, uint8 j) public view returns (uint256 x, uint256 y) {
        uint256[2] storage cached = c.pk[j];
        if (cached[0] != 0 || cached[1] != 0) return (cached[0], cached[1]);
        x = 0;
        y = 1;
        for (uint8 i = 1; i <= c.n; ++i) {
            if (!_inGoodStanding(c, i)) continue;
            (uint256 px, uint256 py) = _evalCommitments(c, i, j);
            (x, y) = BabyJub.add(x, y, px, py);
        }
    }

    // ---------------------------------------------------------- challenges

    function schnorrChallenge(
        uint32 electionId,
        uint8 index,
        uint256[] calldata cx,
        uint256[] calldata cy,
        uint256 rX,
        uint256 rY
    ) public view returns (uint256) {
        return uint256(
            keccak256(abi.encode(SCHNORR_DOMAIN, block.chainid, address(this), electionId, index, cx, cy, rX, rY))
        ) % BabyJub.ORDER;
    }

    function shareChallenge(uint32 electionId, uint8 dealer, uint8 recipient, uint256 share, uint256 rX, uint256 rY)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
            abi.encode(SHARE_DOMAIN, block.chainid, address(this), electionId, dealer, recipient, share, rX, rY)
        )
        ) % BabyJub.ORDER;
    }

    function decryptChallenge(
        uint32 electionId,
        uint256 option,
        uint8 index,
        uint256[2] memory pk,
        uint256[2] memory c1,
        uint256[2] memory d,
        uint256[2] memory a,
        uint256[2] memory b
    ) public view returns (uint256) {
        return uint256(
            keccak256(
            abi.encode(DECRYPT_DOMAIN, block.chainid, address(this), electionId, option, index, pk, c1, d, a, b)
        )
        ) % BabyJub.ORDER;
    }

    // ------------------------------------------------------------ internal

    function _chaumPedersen(
        uint32 electionId,
        uint256 option,
        uint8 index,
        uint256 pkX,
        uint256 pkY,
        uint256 c1x,
        uint256 c1y,
        Share calldata s
    ) private view returns (bool) {
        if (!BabyJub.onCurve(s.dX, s.dY) || !BabyJub.onCurve(s.aX, s.aY) || !BabyJub.onCurve(s.bX, s.bY)) {
            return false;
        }
        uint256 e = decryptChallenge(
            electionId, option, index, [pkX, pkY], [c1x, c1y], [s.dX, s.dY], [s.aX, s.aY], [s.bX, s.bY]
        );
        // z·G = A + e·PK
        (uint256 lx, uint256 ly) = BabyJub.mulBase(s.z);
        (uint256 ex, uint256 ey) = BabyJub.mul(pkX, pkY, e);
        (uint256 rx, uint256 ry) = BabyJub.add(s.aX, s.aY, ex, ey);
        if (lx != rx || ly != ry) return false;
        // z·c1 = B + e·D
        (lx, ly) = BabyJub.mul(c1x, c1y, s.z);
        (ex, ey) = BabyJub.mul(s.dX, s.dY, e);
        (rx, ry) = BabyJub.add(s.bX, s.bY, ex, ey);
        return lx == rx && ly == ry;
    }

    function _schnorr(uint256 c0x, uint256 c0y, uint256 rX, uint256 rY, uint256 z, uint256 e)
        private
        pure
        returns (bool)
    {
        if (!BabyJub.onCurve(rX, rY)) return false;
        (uint256 lx, uint256 ly) = BabyJub.mulBase(z);
        (uint256 ex, uint256 ey) = BabyJub.mul(c0x, c0y, e);
        (uint256 rx, uint256 ry) = BabyJub.add(rX, rY, ex, ey);
        return lx == rx && ly == ry;
    }

    /// @dev `share · G == Σ_t at^t · C_{dealer,t}`.
    function _opens(Committee storage c, uint8 dealer, uint8 at, uint256 share) private view returns (bool) {
        (uint256 ex, uint256 ey) = _evalCommitments(c, dealer, at);
        (uint256 sx, uint256 sy) = BabyJub.mulBase(share);
        return sx == ex && sy == ey;
    }

    function _evalCommitments(Committee storage c, uint8 dealer, uint8 at) private view returns (uint256 x, uint256 y) {
        uint256[] storage cx = c.cx[dealer];
        uint256[] storage cy = c.cy[dealer];
        x = 0;
        y = 1;
        uint256 pow = 1;
        for (uint256 t; t < cx.length; ++t) {
            (uint256 mx, uint256 my) = BabyJub.mul(cx[t], cy[t], pow);
            (x, y) = BabyJub.add(x, y, mx, my);
            pow = mulmod(pow, at, BabyJub.ORDER);
        }
    }

    function _liveMember(Committee storage c, address who) private view returns (uint8 index) {
        index = c.indexOf[who];
        if (index == 0 || c.excluded & (uint32(1) << index) != 0) revert NotMember();
    }

    function _requireCommittedDealer(Committee storage c, uint8 dealer) private view {
        if (dealer == 0 || dealer > c.n || !_inGoodStanding(c, dealer)) revert NotMember();
    }

    function _inGoodStanding(Committee storage c, uint8 i) private view returns (bool) {
        return c.excluded & (uint32(1) << i) == 0 && c.cx[i].length != 0;
    }

    function _liveCount(Committee storage c) private view returns (uint8 live) {
        for (uint8 i = 1; i <= c.n; ++i) {
            if (c.excluded & (uint32(1) << i) == 0) live += 1;
        }
    }

    function _exclude(Committee storage c, uint8 dealer) private {
        uint32 bit = uint32(1) << dealer;
        if (c.excluded & bit != 0) return;
        c.excluded |= bit;
        if (c.cx[dealer].length != 0) c.committed -= 1;
        c.disputed &= ~bit;
    }
}
