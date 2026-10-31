// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title BabyJub
/// @notice Baby Jubjub, the twisted Edwards curve native to the BN254 scalar field.
/// @dev Ciphertexts, the joint key, and guardian shares live on this curve so a
///      Groth16 circuit can check a one-hot ballot with native field arithmetic.
///      Solidity has no precompile for it. Addition and scalar multiplication use
///      projective coordinates and `mulmod`, and one Fermat inversion at the end.
///      The identity is `(0, 1)`. `(0, 0)` is not on the curve; callers keep it as
///      an empty accumulator, the same sentinel the BN254 path used for "no point".
library BabyJub {
    /// @notice Base field, which is the BN254 scalar field.
    uint256 internal constant P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @notice Prime subgroup order.
    uint256 internal constant ORDER =
        2736030358979909402780800718157159386076813972158567259200215660948447373041;
    uint256 internal constant A = 168700;
    uint256 internal constant D = 168696;
    /// @notice Generator Base8.
    uint256 internal constant GX =
        5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant GY =
        16950150798460657717958625567821834550301663161624707787222815936182638968203;

    /// @notice Curve equation `a x^2 + y^2 = 1 + d x^2 y^2`. Identity `(0, 1)` passes.
    function onCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        uint256 lhs = addmod(mulmod(A, x2, P), y2, P);
        uint256 rhs = addmod(1, mulmod(mulmod(D, x2, P), y2, P), P);
        return lhs == rhs;
    }

    /// @notice Empty sentinel, or a curve point that is not pure 8-torsion.
    ///         Three doublings: `[8]P = identity` is the small cofactor subgroup.
    function validPoint(uint256 x, uint256 y) internal pure returns (bool) {
        if (x == 0 && y == 0) return true;
        if (!onCurve(x, y)) return false;
        (uint256 X, uint256 Y, uint256 Z) = _dblProj(x, y, 1);
        (X, Y, Z) = _dblProj(X, Y, Z);
        (X, Y, Z) = _dblProj(X, Y, Z);
        (X, Y) = _affine(X, Y, Z);
        return !(X == 0 && Y == 1);
    }

    function neg(uint256 x, uint256 y) internal pure returns (uint256, uint256) {
        if (x == 0 && y == 0) return (0, 0);
        if (x == 0) return (0, y);
        return (P - x, y);
    }

    /// @notice Affine addition. The empty sentinel is a no-op.
    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal pure returns (uint256, uint256) {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);
        uint256 X3;
        uint256 Y3;
        uint256 Z3;
        (X3, Y3, Z3) = _addProj(x1, y1, 1, x2, y2, 1);
        return _affine(X3, Y3, Z3);
    }

    function sub(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal pure returns (uint256, uint256) {
        if (x2 == 0 && y2 == 0) return (x1, y1);
        (uint256 nx, uint256 ny) = neg(x2, y2);
        return add(x1, y1, nx, ny);
    }

    function mulBase(uint256 s) internal pure returns (uint256, uint256) {
        return mul(GX, GY, s);
    }

    /// @notice Variable-base scalar multiplication. Scalar `0` returns the identity `(0, 1)`.
    function mul(uint256 x, uint256 y, uint256 s) internal pure returns (uint256 xOut, uint256 yOut) {
        if (x == 0 && y == 0) return (0, 0);
        uint256 k = s % ORDER;
        uint256 X = 0;
        uint256 Y = 1;
        uint256 Z = 1;
        uint256 BX = x;
        uint256 BY = y;
        uint256 BZ = 1;
        while (k > 0) {
            if (k & 1 == 1) {
                (X, Y, Z) = _addProj(X, Y, Z, BX, BY, BZ);
            }
            (BX, BY, BZ) = _dblProj(BX, BY, BZ);
            k >>= 1;
        }
        return _affine(X, Y, Z);
    }

    /// @dev Projective add on twisted Edwards. `(X:Y:Z)` is the affine point `(X/Z, Y/Z)`.
    function _addProj(uint256 X1, uint256 Y1, uint256 Z1, uint256 X2, uint256 Y2, uint256 Z2)
        private
        pure
        returns (uint256 X3, uint256 Y3, uint256 Z3)
    {
        uint256 A_ = mulmod(Z1, Z2, P);
        uint256 B = mulmod(A_, A_, P);
        uint256 C = mulmod(X1, X2, P);
        uint256 D_ = mulmod(Y1, Y2, P);
        uint256 E = mulmod(mulmod(D, C, P), D_, P);
        uint256 F = addmod(B, P - E, P);
        uint256 G = addmod(B, E, P);
        uint256 sum1 = addmod(X1, Y1, P);
        uint256 sum2 = addmod(X2, Y2, P);
        uint256 mixed = addmod(mulmod(sum1, sum2, P), P - addmod(C, D_, P), P);
        X3 = mulmod(mulmod(A_, F, P), mixed, P);
        uint256 aC = mulmod(A, C, P);
        Y3 = mulmod(mulmod(A_, G, P), addmod(D_, P - aC, P), P);
        Z3 = mulmod(F, G, P);
    }

    function _dblProj(uint256 X1, uint256 Y1, uint256 Z1) private pure returns (uint256 X3, uint256 Y3, uint256 Z3) {
        uint256 B = mulmod(addmod(X1, Y1, P), addmod(X1, Y1, P), P);
        uint256 C = mulmod(X1, X1, P);
        uint256 D_ = mulmod(Y1, Y1, P);
        uint256 E = mulmod(A, C, P);
        uint256 F = addmod(E, D_, P);
        uint256 H = mulmod(Z1, Z1, P);
        uint256 twoH = addmod(H, H, P);
        uint256 J = addmod(F, P - twoH, P);
        X3 = mulmod(addmod(B, P - addmod(C, D_, P), P), J, P);
        Y3 = mulmod(F, addmod(E, P - D_, P), P);
        Z3 = mulmod(F, J, P);
    }

    function _affine(uint256 X, uint256 Y, uint256 Z) private pure returns (uint256, uint256) {
        uint256 inv = _inv(Z);
        return (mulmod(X, inv, P), mulmod(Y, inv, P));
    }

    /// @notice Running ciphertext sum. Empty `(0, 0)` is skipped. One inversion at the end.
    struct Run {
        uint256 x1;
        uint256 y1;
        uint256 z1;
        uint256 x2;
        uint256 y2;
        uint256 z2;
        bool live;
    }

    function runAdd(Run memory r, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) internal pure returns (Run memory) {
        return _absorb(r, c1x, c1y, c2x, c2y, true);
    }

    function runSub(Run memory r, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) internal pure returns (Run memory) {
        return _absorb(r, c1x, c1y, c2x, c2y, false);
    }

    function runOut(Run memory r) internal pure returns (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) {
        if (!r.live) return (0, 0, 0, 0);
        (c1x, c1y) = _affine(r.x1, r.y1, r.z1);
        (c2x, c2y) = _affine(r.x2, r.y2, r.z2);
    }

    function _absorb(Run memory r, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, bool plus)
        private
        pure
        returns (Run memory)
    {
        if (c1x == 0 && c1y == 0 && c2x == 0 && c2y == 0) return r;
        if (!plus) {
            if (c1x != 0) c1x = P - c1x;
            if (c2x != 0) c2x = P - c2x;
        }
        if (!r.live) {
            r.x1 = c1x;
            r.y1 = c1y;
            r.z1 = 1;
            r.x2 = c2x;
            r.y2 = c2y;
            r.z2 = 1;
            r.live = true;
            return r;
        }
        (r.x1, r.y1, r.z1) = _addProj(r.x1, r.y1, r.z1, c1x, c1y, 1);
        (r.x2, r.y2, r.z2) = _addProj(r.x2, r.y2, r.z2, c2x, c2y, 1);
        return r;
    }

    function _inv(uint256 a) private pure returns (uint256 res) {
        res = 1;
        uint256 base = a % P;
        uint256 exp = P - 2;
        unchecked {
            while (exp > 0) {
                if (exp & 1 == 1) res = mulmod(res, base, P);
                base = mulmod(base, base, P);
                exp >>= 1;
            }
        }
    }
}
