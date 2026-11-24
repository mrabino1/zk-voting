// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IBatchVerifier} from "../interfaces/IBatchVerifier.sol";

/// @title MockBatchVerifier
/// @notice Accepts any proof whose first word is non-zero. Development only:
///         `ZkVotingRollup` refuses a mock verifier outside chain id 31337.
contract MockBatchVerifier is IBatchVerifier {
    function verifyProof(uint256[8] calldata proof, uint256) external pure returns (bool) {
        return proof[0] != 0;
    }

    function isMock() external pure returns (bool) {
        return true;
    }
}
