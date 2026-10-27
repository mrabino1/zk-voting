// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "./IGroth16Verifier.sol";

interface IMockVerifier is IGroth16Verifier {
    error NotOwner();
    error InvalidInputLength();
    error WitnessLengthMismatch();
    error InvalidWitnessDepth();

    function owner() external view returns (address);

    function acceptAll() external view returns (bool);

    function deniedNullifiers(bytes32 nullifier) external view returns (bool);

    /// @notice Hasher for the optional inclusion hook. Keccak in Foundry tests.
    function inclusionHasher() external view returns (address);

    function witnessTreeDepth() external view returns (uint8);

    function isMock() external pure returns (bool);

    function setAccept(bool accept) external;

    function setDeniedNullifier(bytes32 nullifier, bool denied) external;

    function setInclusionHasher(address hasher_) external;

    function setWitnessTreeDepth(uint8 depth) external;

    function armInclusionWitness(
        uint256 nullifier,
        uint256 leaf,
        uint256[] calldata pathElements,
        uint8[] calldata pathIndices
    ) external;

    function clearInclusionWitness(uint256 nullifier) external;

    function inclusionArmed(uint256 nullifier) external view returns (bool);

    function armNonMembershipWitness(
        uint256 nullifier,
        uint256 leaf,
        uint256 low,
        uint256 next,
        uint256[] calldata pathElements,
        uint8[] calldata pathIndices
    ) external;

    function nonMembershipArmed(uint256 nullifier) external view returns (bool);
}
