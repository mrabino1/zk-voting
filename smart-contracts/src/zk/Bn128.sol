// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title Bn128
/// @notice alt_bn128 addition and multiplication via precompiles 6 and 7.
library Bn128 {
    /// @notice Scalar field order of alt_bn128.
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function mul(uint256 x, uint256 y, uint256 s) internal view returns (bool ok, uint256 xOut, uint256 yOut) {
        uint256[3] memory input;
        input[0] = x;
        input[1] = y;
        input[2] = s % R;
        uint256[2] memory output;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 7, input, 96, output, 64)
        }
        xOut = output[0];
        yOut = output[1];
    }

    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (bool ok, uint256 xOut, uint256 yOut)
    {
        uint256[4] memory input;
        input[0] = x1;
        input[1] = y1;
        input[2] = x2;
        input[3] = y2;
        uint256[2] memory output;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 6, input, 128, output, 64)
        }
        xOut = output[0];
        yOut = output[1];
    }

    /// @notice Negate a point on the base field. The identity `(0, 0)` stays put.
    function neg(uint256 x, uint256 y) internal pure returns (uint256 xOut, uint256 yOut) {
        if (x == 0 && y == 0) return (0, 0);
        uint256 p = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        xOut = x;
        yOut = y == 0 ? 0 : p - y;
    }

    /// @notice True when `(x, y)` is on the curve. Multiplication by 1 returns the same point.
    function onCurve(uint256 x, uint256 y) internal view returns (bool) {
        (bool ok, uint256 xOut, uint256 yOut) = mul(x, y, 1);
        return ok && xOut == x && yOut == y && (x != 0 || y != 0);
    }

    /// @notice Identity, or a prime-order point. The BN254 G1 cofactor is 1, so
    ///         the curve equation is the subgroup check. Scalar `R` is 0 mod r
    ///         and cannot be used as a membership test.
    function validPoint(uint256 x, uint256 y) internal view returns (bool) {
        if (x == 0 && y == 0) return true;
        uint256 p = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        if (x >= p || y >= p) return false;
        uint256 yy = mulmod(y, y, p);
        uint256 xxx = mulmod(mulmod(x, x, p), x, p);
        if (yy != addmod(xxx, 3, p)) return false;
        return onCurve(x, y);
    }

    /// @notice Sum that treats the identity as a no-op. The precompile rejects `(0, 0)`.
    function ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (bool ok, uint256 xOut, uint256 yOut)
    {
        if (x1 == 0 && y1 == 0) return (true, x2, y2);
        if (x2 == 0 && y2 == 0) return (true, x1, y1);
        return add(x1, y1, x2, y2);
    }

    function ecSub(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (bool ok, uint256 xOut, uint256 yOut)
    {
        (uint256 nx, uint256 ny) = neg(x2, y2);
        return ecAdd(x1, y1, nx, ny);
    }
}
