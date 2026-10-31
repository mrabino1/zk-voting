// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn128} from "./Bn128.sol";

/// @title OneHot
/// @notice OR Chaum-Pedersen proof that an ElGamal ciphertext encrypts 0 or 1
///         under the ceremony joint key. The circuit binds the same ciphertext
///         with CipherHash. Curve coordinates stay on chain: a circom signal
///         cannot hold a base-field element.
library OneHot {
    bytes32 internal constant DOMAIN = keccak256("ONE_HOT_CDS_V1");

    bytes32 internal constant SUM_DOMAIN = keccak256("SUM_TO_ONE_V1");

    /// @dev Proof words: A0, B0, e0, z0, A1, B1, e1, z1. Twelve field elements.
    ///      The challenge binds chain id, this settlement, the election, the submission,
    ///      and the option index. The primary ciphertext uses `type(uint256).max`.
    ///      Option `j` uses `j`, so a proof built for another slot does not verify.
    function verify(
        uint256 pkX,
        uint256 pkY,
        uint256 c1X,
        uint256 c1Y,
        uint256 c2X,
        uint256 c2Y,
        uint256[12] memory proof,
        uint256 electionId,
        uint256 submissionId,
        uint256 optionIndex
    ) internal view returns (bool) {
        if (!Bn128.validPoint(pkX, pkY) || !Bn128.validPoint(c1X, c1Y) || !Bn128.validPoint(c2X, c2Y)) {
            return false;
        }
        if (c1X == 0 && c1Y == 0) return false;
        uint256 e = uint256(
            keccak256(
                abi.encode(
                    DOMAIN,
                    block.chainid,
                    address(this),
                    electionId,
                    submissionId,
                    optionIndex,
                    pkX,
                    pkY,
                    c1X,
                    c1Y,
                    c2X,
                    c2Y,
                    proof[0],
                    proof[1],
                    proof[2],
                    proof[3],
                    proof[6],
                    proof[7],
                    proof[8],
                    proof[9]
                )
            )
        ) % Bn128.R;
        if (addmod(proof[4], proof[10], Bn128.R) != e) return false;
        uint256[6] memory base = [pkX, pkY, c1X, c1Y, c2X, c2Y];
        uint256[6] memory left = [proof[0], proof[1], proof[2], proof[3], proof[4], proof[5]];
        uint256[6] memory right = [proof[6], proof[7], proof[8], proof[9], proof[10], proof[11]];
        if (!_branch(base, left, false)) return false;
        return _branch(base, right, true);
    }

    /// @dev Chaum-Pedersen that `log_G(S1) = log_PK(S2 - G)`, so the option ciphertexts sum to Enc(1).
    ///      `proof` is A, B, z. The challenge uses the same chain, settlement, election, and submission.
    function verifySum(
        uint256 pkX,
        uint256 pkY,
        uint256 s1X,
        uint256 s1Y,
        uint256 s2X,
        uint256 s2Y,
        uint256[5] memory proof,
        uint256 electionId,
        uint256 submissionId
    ) internal view returns (bool) {
        if (!Bn128.validPoint(pkX, pkY) || !Bn128.validPoint(s1X, s1Y) || !Bn128.validPoint(s2X, s2Y)) return false;
        if (!Bn128.validPoint(proof[0], proof[1]) || !Bn128.validPoint(proof[2], proof[3])) return false;
        (bool okS, uint256 mx, uint256 my) = Bn128.ecSub(s2X, s2Y, 1, 2);
        if (!okS) return false;
        uint256 e = uint256(
            keccak256(
                abi.encode(
                    SUM_DOMAIN,
                    block.chainid,
                    address(this),
                    electionId,
                    submissionId,
                    pkX,
                    pkY,
                    s1X,
                    s1Y,
                    s2X,
                    s2Y,
                    proof[0],
                    proof[1],
                    proof[2],
                    proof[3]
                )
            )
        ) % Bn128.R;
        if (!_eq(1, 2, proof[4], proof[0], proof[1], s1X, s1Y, e)) return false;
        return _eq(pkX, pkY, proof[4], proof[2], proof[3], mx, my, e);
    }

    /// @dev `base` is pk, c1, c2. `limb` is A, B, e, z. `minusG` checks the bit-1 ciphertext.
    function _branch(uint256[6] memory base, uint256[6] memory limb, bool minusG) private view returns (bool) {
        if (!Bn128.validPoint(limb[0], limb[1]) || !Bn128.validPoint(limb[2], limb[3])) return false;
        uint256 mX = base[4];
        uint256 mY = base[5];
        if (minusG) {
            (bool okS, uint256 sx, uint256 sy) = Bn128.ecSub(base[4], base[5], 1, 2);
            if (!okS) return false;
            mX = sx;
            mY = sy;
        }
        if (!_eq(1, 2, limb[5], limb[0], limb[1], base[2], base[3], limb[4])) return false;
        return _eq(base[0], base[1], limb[5], limb[2], limb[3], mX, mY, limb[4]);
    }

    /// @dev `base^z = commit + e·key`.
    function _eq(
        uint256 baseX,
        uint256 baseY,
        uint256 z,
        uint256 commitX,
        uint256 commitY,
        uint256 keyX,
        uint256 keyY,
        uint256 e
    ) private view returns (bool) {
        (bool okL, uint256 lx, uint256 ly) = Bn128.mul(baseX, baseY, z);
        if (!okL) return false;
        (bool okE, uint256 ex, uint256 ey) = Bn128.mul(keyX, keyY, e);
        if (!okE) return false;
        (bool okR, uint256 rx, uint256 ry) = Bn128.ecAdd(commitX, commitY, ex, ey);
        return okR && lx == rx && ly == ry;
    }
}
