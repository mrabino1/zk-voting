// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IBatchVerifier} from "../interfaces/IBatchVerifier.sol";

/// @title Groth16Verifier
/// @notice Groth16 over BN254 for a circuit with exactly one public input (the batch
///         commitment). The verifying key is fixed at deployment and cannot change.
/// @dev Same check as snarkjs `verifier_groth16.sol`:
///      `e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1`, with `vk_x = IC0 + input · IC1`.
///      G2 coordinates are in the EIP-197 order `(x1, x0, y1, y0)`.
contract Groth16Verifier is IBatchVerifier {
    uint256 internal constant Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct VerifyingKey {
        uint256[2] alpha;
        uint256[4] beta;
        uint256[4] gamma;
        uint256[4] delta;
        uint256[2] ic0;
        uint256[2] ic1;
    }

    error EmptyVerifyingKey();

    uint256 internal immutable ALPHA_X;
    uint256 internal immutable ALPHA_Y;
    uint256 internal immutable BETA_X1;
    uint256 internal immutable BETA_X0;
    uint256 internal immutable BETA_Y1;
    uint256 internal immutable BETA_Y0;
    uint256 internal immutable GAMMA_X1;
    uint256 internal immutable GAMMA_X0;
    uint256 internal immutable GAMMA_Y1;
    uint256 internal immutable GAMMA_Y0;
    uint256 internal immutable DELTA_X1;
    uint256 internal immutable DELTA_X0;
    uint256 internal immutable DELTA_Y1;
    uint256 internal immutable DELTA_Y0;
    uint256 internal immutable IC0_X;
    uint256 internal immutable IC0_Y;
    uint256 internal immutable IC1_X;
    uint256 internal immutable IC1_Y;

    /// @notice keccak256 of the ABI-encoded verifying key, for auditors to compare.
    bytes32 public immutable verifyingKeyHash;

    constructor(VerifyingKey memory vk) {
        if (vk.alpha[0] == 0 && vk.alpha[1] == 0) revert EmptyVerifyingKey();
        (ALPHA_X, ALPHA_Y) = (vk.alpha[0], vk.alpha[1]);
        (BETA_X1, BETA_X0, BETA_Y1, BETA_Y0) = (vk.beta[0], vk.beta[1], vk.beta[2], vk.beta[3]);
        (GAMMA_X1, GAMMA_X0, GAMMA_Y1, GAMMA_Y0) = (vk.gamma[0], vk.gamma[1], vk.gamma[2], vk.gamma[3]);
        (DELTA_X1, DELTA_X0, DELTA_Y1, DELTA_Y0) = (vk.delta[0], vk.delta[1], vk.delta[2], vk.delta[3]);
        (IC0_X, IC0_Y) = (vk.ic0[0], vk.ic0[1]);
        (IC1_X, IC1_Y) = (vk.ic1[0], vk.ic1[1]);
        verifyingKeyHash = keccak256(abi.encode(vk));
    }

    function isMock() external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IBatchVerifier
    function verifyProof(uint256[8] calldata proof, uint256 commitment) external view returns (bool) {
        if (commitment >= R) return false;
        for (uint256 i; i < 8; ++i) {
            if (proof[i] >= Q) return false;
        }
        (bool ok, uint256 vkX, uint256 vkY) = _ecMul(IC1_X, IC1_Y, commitment);
        if (!ok) return false;
        (ok, vkX, vkY) = _ecAdd(IC0_X, IC0_Y, vkX, vkY);
        if (!ok) return false;

        uint256[24] memory input;
        // e(-A, B)
        input[0] = proof[0];
        input[1] = proof[1] == 0 ? 0 : Q - proof[1];
        input[2] = proof[2];
        input[3] = proof[3];
        input[4] = proof[4];
        input[5] = proof[5];
        // e(alpha, beta)
        input[6] = ALPHA_X;
        input[7] = ALPHA_Y;
        input[8] = BETA_X1;
        input[9] = BETA_X0;
        input[10] = BETA_Y1;
        input[11] = BETA_Y0;
        // e(vk_x, gamma)
        input[12] = vkX;
        input[13] = vkY;
        input[14] = GAMMA_X1;
        input[15] = GAMMA_X0;
        input[16] = GAMMA_Y1;
        input[17] = GAMMA_Y0;
        // e(C, delta)
        input[18] = proof[6];
        input[19] = proof[7];
        input[20] = DELTA_X1;
        input[21] = DELTA_X0;
        input[22] = DELTA_Y1;
        input[23] = DELTA_Y0;

        uint256[1] memory out;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x08, input, 768, out, 32)
        }
        return ok && out[0] == 1;
    }

    function _ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        private
        view
        returns (bool ok, uint256 x, uint256 y)
    {
        uint256[4] memory input = [x1, y1, x2, y2];
        uint256[2] memory out;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x06, input, 128, out, 64)
        }
        (x, y) = (out[0], out[1]);
    }

    function _ecMul(uint256 px, uint256 py, uint256 s) private view returns (bool ok, uint256 x, uint256 y) {
        uint256[3] memory input = [px, py, s];
        uint256[2] memory out;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 0x07, input, 96, out, 64)
        }
        (x, y) = (out[0], out[1]);
    }
}
