// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "./IGroth16Verifier.sol";

interface IVoteVerifier is IGroth16Verifier {
    error VerifierNotConfigured();

    function PUBLIC_INPUT_COUNT() external view returns (uint256);

    function SNARK_SCALAR_FIELD() external view returns (uint256);

    function PRIME_Q() external view returns (uint256);

    function verifyingKeyHash() external view returns (bytes32);

    function mockVerifier() external view returns (address);

    function hasKey() external view returns (bool);

    function isMock() external view returns (bool);

    function alpha() external view returns (uint256 x, uint256 y);

    function icAt(uint256 i) external view returns (uint256 x, uint256 y);
}
