// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/// @title VoteVerifier
/// @notice Structural Groth16 verifier for the vote circuit (5 public inputs).
/// @dev Placeholder verifying key (alpha, beta, gamma, delta, IC) is all zeros.
///      snarkjs-generated keys replace the constants after a trusted setup.
///      This contract does **not** fake a pairing that always returns true.
///      When `verifyingKeyHash == bytes32(0)` the key is unconfigured: we
///      delegate to `mockVerifier` if set, otherwise revert `VerifierNotConfigured()`.
///      `REPUBLIC_PROVING_PATH=1` deploys this with `mockVerifier = address(0)`.
///
/// Public inputs convention:
///      input[0] = eligibleRoot
///      input[1] = disqualificationRoot
///      input[2] = nullifier
///      input[3] = ballotHash (uint256)
///      input[4] = electionId
contract VoteVerifier is IGroth16Verifier {
    error VerifierNotConfigured();

    /// @notice Vote circuit public input count (eligible, disq, nullifier, ballotHash, electionId).
    uint256 public constant PUBLIC_INPUT_COUNT = 5;

    /// @notice bn254 scalar field (Fr). Public inputs must be in this field.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice bn254 base field (Fq). G1/G2 coordinates live here for pairing.
    uint256 public constant PRIME_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    struct G2Point {
        uint256[2] x;
        uint256[2] y;
    }

    // -------------------------------------------------------------------------
    // Hardcoded verifying key placeholder. Replace with snarkjs output.
    // IC has 6 G1 points (constant term + 5 public-input coefficients).
    // User-facing "5 IC points" are IC[1]..IC[5]; IC[0] is the VK constant.
    // -------------------------------------------------------------------------
    uint256 internal constant ALPHA_X = 0;
    uint256 internal constant ALPHA_Y = 0;

    uint256 internal constant BETA_X0 = 0;
    uint256 internal constant BETA_X1 = 0;
    uint256 internal constant BETA_Y0 = 0;
    uint256 internal constant BETA_Y1 = 0;

    uint256 internal constant GAMMA_X0 = 0;
    uint256 internal constant GAMMA_X1 = 0;
    uint256 internal constant GAMMA_Y0 = 0;
    uint256 internal constant GAMMA_Y1 = 0;

    uint256 internal constant DELTA_X0 = 0;
    uint256 internal constant DELTA_X1 = 0;
    uint256 internal constant DELTA_Y0 = 0;
    uint256 internal constant DELTA_Y1 = 0;

    uint256 internal constant IC0_X = 0;
    uint256 internal constant IC0_Y = 0;
    uint256 internal constant IC1_X = 0;
    uint256 internal constant IC1_Y = 0;
    uint256 internal constant IC2_X = 0;
    uint256 internal constant IC2_Y = 0;
    uint256 internal constant IC3_X = 0;
    uint256 internal constant IC3_Y = 0;
    uint256 internal constant IC4_X = 0;
    uint256 internal constant IC4_Y = 0;
    uint256 internal constant IC5_X = 0;
    uint256 internal constant IC5_Y = 0;

    /// @notice keccak256 of the production VK. Zero until snarkjs keys are installed.
    bytes32 public verifyingKeyHash;

    /// @notice Optional MockVerifier used only while the VK is unconfigured.
    address public mockVerifier;

    G1Point internal _alpha;
    G2Point internal _beta;
    G2Point internal _gamma;
    G2Point internal _delta;
    /// @notice IC[0] + five public-input points (zeros until snarkjs replacement).
    G1Point[6] internal _ic;

    constructor(address mockVerifier_) {
        mockVerifier = mockVerifier_;
        // Copy placeholder constants into storage so the pairing path is not
        // constant-folded away while VERIFYING_KEY_HASH is still zero.
        _alpha = G1Point({x: ALPHA_X, y: ALPHA_Y});
        _beta.x[0] = BETA_X0;
        _beta.x[1] = BETA_X1;
        _beta.y[0] = BETA_Y0;
        _beta.y[1] = BETA_Y1;
        _gamma.x[0] = GAMMA_X0;
        _gamma.x[1] = GAMMA_X1;
        _gamma.y[0] = GAMMA_Y0;
        _gamma.y[1] = GAMMA_Y1;
        _delta.x[0] = DELTA_X0;
        _delta.x[1] = DELTA_X1;
        _delta.y[0] = DELTA_Y0;
        _delta.y[1] = DELTA_Y1;
        _ic[0] = G1Point({x: IC0_X, y: IC0_Y});
        _ic[1] = G1Point({x: IC1_X, y: IC1_Y});
        _ic[2] = G1Point({x: IC2_X, y: IC2_Y});
        _ic[3] = G1Point({x: IC3_X, y: IC3_Y});
        _ic[4] = G1Point({x: IC4_X, y: IC4_Y});
        _ic[5] = G1Point({x: IC5_X, y: IC5_Y});
        verifyingKeyHash = bytes32(0);
    }

    /// @notice True when a non-zero verifying key hash has been installed.
    function hasKey() public view returns (bool) {
        return verifyingKeyHash != bytes32(0);
    }

    /// @notice True while the VK is unconfigured and proofs are delegated to a
    ///         mock. `ElectionFactory` refuses such a verifier unless mock
    ///         verifiers are explicitly allowed (audit H-02).
    function isMock() external view returns (bool) {
        return !hasKey() && mockVerifier != address(0);
    }

    function alpha() external view returns (uint256 x, uint256 y) {
        return (_alpha.x, _alpha.y);
    }

    function icAt(uint256 i) external view returns (uint256 x, uint256 y) {
        G1Point memory p = _ic[i];
        return (p.x, p.y);
    }

    /// @inheritdoc IGroth16Verifier
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata input
    ) external view returns (bool) {
        if (!hasKey()) {
            if (mockVerifier == address(0)) revert VerifierNotConfigured();
            return IGroth16Verifier(mockVerifier).verifyProof(a, b, c, input);
        }

        if (!_pairingShapedPointsInField(a, b, c)) return false;
        if (input.length != PUBLIC_INPUT_COUNT) return false;
        for (uint256 i = 0; i < PUBLIC_INPUT_COUNT; ++i) {
            if (input[i] >= SNARK_SCALAR_FIELD) return false;
        }

        // Placeholder zeros are not a verifying key. A degenerate pairing of
        // the identity / (0,0) points can return 1; never treat that as valid.
        if (_alpha.x == 0 && _alpha.y == 0 && _ic[0].x == 0 && _ic[0].y == 0) {
            return false;
        }

        return _verifyGroth16(a, b, c, input);
    }

    /// @dev Proof G1/G2 limbs must lie in Fq. Public inputs are checked against Fr
    ///      (the modulus given in the v1 spec).
    function _pairingShapedPointsInField(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c)
        internal
        pure
        returns (bool)
    {
        if (a[0] >= PRIME_Q || a[1] >= PRIME_Q) return false;
        if (c[0] >= PRIME_Q || c[1] >= PRIME_Q) return false;
        if (b[0][0] >= PRIME_Q || b[0][1] >= PRIME_Q) return false;
        if (b[1][0] >= PRIME_Q || b[1][1] >= PRIME_Q) return false;
        return true;
    }

    /// @dev e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1 via precompile 0x08.
    ///      Never short-circuits to true. Invalid / placeholder keys return false.
    function _verifyGroth16(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata input
    ) internal view returns (bool) {
        uint256[2] memory vkx = _accumulateVkX(input);
        if (vkx[0] == type(uint256).max) return false;

        uint256[24] memory pairingInput;
        uint256 negAy = a[1] == 0 ? 0 : mulmod(a[1], PRIME_Q - 1, PRIME_Q);

        pairingInput[0] = a[0];
        pairingInput[1] = negAy;
        pairingInput[2] = b[0][0];
        pairingInput[3] = b[0][1];
        pairingInput[4] = b[1][0];
        pairingInput[5] = b[1][1];

        pairingInput[6] = _alpha.x;
        pairingInput[7] = _alpha.y;
        pairingInput[8] = _beta.x[0];
        pairingInput[9] = _beta.x[1];
        pairingInput[10] = _beta.y[0];
        pairingInput[11] = _beta.y[1];

        pairingInput[12] = vkx[0];
        pairingInput[13] = vkx[1];
        pairingInput[14] = _gamma.x[0];
        pairingInput[15] = _gamma.x[1];
        pairingInput[16] = _gamma.y[0];
        pairingInput[17] = _gamma.y[1];

        pairingInput[18] = c[0];
        pairingInput[19] = c[1];
        pairingInput[20] = _delta.x[0];
        pairingInput[21] = _delta.x[1];
        pairingInput[22] = _delta.y[0];
        pairingInput[23] = _delta.y[1];

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(gas(), 0x08, pairingInput, 0x300, out, 0x20)
        }
        return success && out[0] == 1;
    }

    /// @dev vk_x = IC[0] + Σ input[i] · IC[i+1]. Returns (max, 0) on precompile failure.
    function _accumulateVkX(uint256[] calldata input) internal view returns (uint256[2] memory vkx) {
        vkx[0] = _ic[0].x;
        vkx[1] = _ic[0].y;
        for (uint256 i = 0; i < PUBLIC_INPUT_COUNT; ++i) {
            (bool okMul, uint256 mx, uint256 my) = _ecMul(_ic[i + 1].x, _ic[i + 1].y, input[i]);
            if (!okMul) {
                vkx[0] = type(uint256).max;
                return vkx;
            }
            (bool okAdd, uint256 ax, uint256 ay) = _ecAdd(vkx[0], vkx[1], mx, my);
            if (!okAdd) {
                vkx[0] = type(uint256).max;
                return vkx;
            }
            vkx[0] = ax;
            vkx[1] = ay;
        }
    }

    function _ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (bool ok, uint256 x, uint256 y)
    {
        uint256[4] memory input;
        input[0] = x1;
        input[1] = y1;
        input[2] = x2;
        input[3] = y2;
        uint256[2] memory output;
        assembly {
            ok := staticcall(gas(), 0x06, input, 0x80, output, 0x40)
        }
        x = output[0];
        y = output[1];
    }

    function _ecMul(uint256 px, uint256 py, uint256 s) internal view returns (bool ok, uint256 x, uint256 y) {
        uint256[3] memory input;
        input[0] = px;
        input[1] = py;
        input[2] = s;
        uint256[2] memory output;
        assembly {
            ok := staticcall(gas(), 0x07, input, 0x60, output, 0x40)
        }
        x = output[0];
        y = output[1];
    }
}
