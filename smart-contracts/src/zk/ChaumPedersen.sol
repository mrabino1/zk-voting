// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BabyJub} from "./BabyJub.sol";

/// @title ChaumPedersen
/// @notice Equality of discrete logs: `log_g(pk) = log_c1(d)`.
/// @dev Proof `(A, B, z)` with challenge
///      `e = keccak256(domain, electionId, hourIndex, guardian, pk, c1, d, A, B) mod r`.
///      Checks `g^z = A + e·pk` and `c1^z = B + e·d` on Baby Jubjub.
///      `z` is the response, not the Shamir share and not the joint scalar.
///      `c1` is the stored aggregate point, not a point the caller picks.
library ChaumPedersen {
    /// @notice Baby Jubjub generator Base8.
    uint256 internal constant GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203;

    bytes32 internal constant DOMAIN = keccak256("CHAUM_PEDERSEN_V1");

    /// @dev `w` is pk, c1, d, A, B, z. Eleven words, so the caller does not pass each scalar.
    function verify(uint256[11] memory w, uint256 electionId, uint256 hourIndex, address guardian)
        internal
        view
        returns (bool)
    {
        if (!BabyJub.onCurve(w[0], w[1]) || !BabyJub.onCurve(w[2], w[3]) || !BabyJub.onCurve(w[4], w[5])) return false;
        if (!BabyJub.onCurve(w[6], w[7]) || !BabyJub.onCurve(w[8], w[9])) return false;
        uint256 e = uint256(
            keccak256(abi.encode(DOMAIN, electionId, hourIndex, guardian, w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9]))
        ) % BabyJub.ORDER;
        if (!_same(GX, GY, w[10], w[6], w[7], w[0], w[1], e)) return false;
        return _same(w[2], w[3], w[10], w[8], w[9], w[4], w[5], e);
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
        (uint256 lx, uint256 ly) = BabyJub.mul(baseX, baseY, z);
        (uint256 ex, uint256 ey) = BabyJub.mul(keyX, keyY, e);
        (uint256 rx, uint256 ry) = BabyJub.add(commitX, commitY, ex, ey);
        return lx == rx && ly == ry;
    }
}
