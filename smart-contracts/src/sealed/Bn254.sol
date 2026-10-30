// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title Bn254
/// @notice G1 add and multiply via the alt-bn128 precompiles (addresses 6 and 7).
/// @dev Generator is (1, 2). The point at infinity is (0, 0). Scalars are
///      reduced by the precompile modulo the group order.
library Bn254 {
    uint256 internal constant GX = 1;
    uint256 internal constant GY = 2;

    function mul(uint256 x, uint256 y, uint256 scalar) internal view returns (uint256 rx, uint256 ry) {
        bytes memory input = abi.encode(x, y, scalar);
        (bool ok, bytes memory out) = address(0x07).staticcall(input);
        if (!ok || out.length < 64) revert MulFailed();
        (rx, ry) = abi.decode(out, (uint256, uint256));
    }

    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (uint256 rx, uint256 ry)
    {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);
        bytes memory input = abi.encode(x1, y1, x2, y2);
        (bool ok, bytes memory out) = address(0x06).staticcall(input);
        if (!ok || out.length < 64) revert AddFailed();
        (rx, ry) = abi.decode(out, (uint256, uint256));
    }

    function mulG(uint256 scalar) internal view returns (uint256 x, uint256 y) {
        return mul(GX, GY, scalar);
    }

    /// @dev True when the precompile accepts the point. Infinity is rejected.
    function isOnCurve(uint256 x, uint256 y) internal view returns (bool) {
        if (x == 0 && y == 0) return false;
        (uint256 rx, uint256 ry) = mul(x, y, 1);
        return rx == x && ry == y;
    }

    error MulFailed();
    error AddFailed();
}
