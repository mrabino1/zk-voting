// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Bn128} from "./Bn128.sol";

/// @title ChaumPedersen
/// @notice Equality of discrete logs: `log_g(pk) = log_c1(d)`.
/// @dev Proof `(A, B, z)` with challenge
///      `e = keccak256(domain, electionId, hourIndex, guardian, pk, c1, d, A, B) mod r`.
///      Checks `g^z = A + e·pk` and `c1^z = B + e·d` on alt_bn128.
///      `z` is the response, not the Shamir share and not the joint scalar.
///      `c1` is the stored aggregate point, not a point the caller picks.
library ChaumPedersen {
    /// @notice Generator of alt_bn128 G1.
    uint256 internal constant GX = 1;
    uint256 internal constant GY = 2;

    bytes32 internal constant DOMAIN = keccak256("CHAUM_PEDERSEN_V1");

    function verify(
        uint256 pkX,
        uint256 pkY,
        uint256 c1X,
        uint256 c1Y,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z,
        uint256 electionId,
        uint256 hourIndex,
        address guardian
    ) internal view returns (bool) {
        if (!Bn128.onCurve(pkX, pkY) || !Bn128.onCurve(c1X, c1Y) || !Bn128.onCurve(dX, dY)) return false;
        if (!Bn128.onCurve(aX, aY) || !Bn128.onCurve(bX, bY)) return false;
        uint256 e = uint256(
            keccak256(
                abi.encode(
                    DOMAIN, electionId, hourIndex, guardian, pkX, pkY, c1X, c1Y, dX, dY, aX, aY, bX, bY
                )
            )
        ) % Bn128.R;
        if (!_same(GX, GY, z, aX, aY, pkX, pkY, e)) return false;
        return _same(c1X, c1Y, z, bX, bY, dX, dY, e);
    }

    function _same(
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
        (bool okR, uint256 rx, uint256 ry) = Bn128.add(commitX, commitY, ex, ey);
        return okR && lx == rx && ly == ry;
    }
}
