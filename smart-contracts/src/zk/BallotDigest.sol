// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IRollupSettlement} from "../interfaces/IRollupSettlement.sol";
import {PoseidonT3} from "../hasher/PoseidonT3.sol";

/// @title BallotDigest
/// @notice Ordered commitment of a primary ciphertext and its option vector.
/// @dev `ct` is Poseidon(Poseidon(c1x, c1y), Poseidon(c2x, c2y)).
///      The ballot hash is Poseidon(ct(primary), n), then Poseidon(acc, ct(option_i))
///      for i in 0..n-1. n = 0 hashes Poseidon(ct(primary), 0), which is not `ct` alone.
///      The option-vector hash is the same fold starting at Poseidon(0, n). An empty
///      vector is Poseidon(0, 0). Coordinates are reduced mod r inside Poseidon.
library BallotDigest {
    function ciphertextHash(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal pure returns (uint256) {
        return PoseidonT3.hashLeftRight(PoseidonT3.hashLeftRight(x1, y1), PoseidonT3.hashLeftRight(x2, y2));
    }

    function commit(
        uint256 c1x,
        uint256 c1y,
        uint256 c2x,
        uint256 c2y,
        IRollupSettlement.OptionCipher[] calldata options
    ) internal pure returns (uint256 h) {
        h = PoseidonT3.hashLeftRight(ciphertextHash(c1x, c1y, c2x, c2y), options.length);
        for (uint256 i; i < options.length; ++i) {
            h = PoseidonT3.hashLeftRight(
                h, ciphertextHash(options[i].c1X, options[i].c1Y, options[i].c2X, options[i].c2Y)
            );
        }
    }

    /// @notice Hash of the option coordinates in order. Proof words are not inputs.
    function vectorHash(IRollupSettlement.OptionCipher[] calldata options) internal pure returns (uint256 h) {
        h = PoseidonT3.hashLeftRight(0, options.length);
        for (uint256 i; i < options.length; ++i) {
            h = PoseidonT3.hashLeftRight(
                h, ciphertextHash(options[i].c1X, options[i].c1Y, options[i].c2X, options[i].c2Y)
            );
        }
    }
}
