// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/// @title MockVerifier
/// @notice Test / local-L2 Groth16 stand-in. Owner toggles `acceptAll`.
/// @dev Foundry unit tests always use this contract. Non-mock integration uses
///      `REPUBLIC_PROVING_PATH=1` (DeployLocal deploys `VoteVerifier` with no mock).
/// @dev Public inputs convention (vote circuit, see `circuits/vote.circom`):
///      input[0] = eligibleRoot
///      input[1] = disqualificationRoot
///      input[2] = nullifier
///      input[3] = ballotHash (uint256)
///      input[4] = electionId
contract MockVerifier is IGroth16Verifier {
    error NotOwner();
    error InvalidInputLength();

    address public immutable owner;
    bool public acceptAll = true;

    /// @notice Optional denylist keyed by `bytes32(nullifier)` (publicInputs[2]).
    mapping(bytes32 => bool) public deniedNullifiers;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setAccept(bool accept) external onlyOwner {
        acceptAll = accept;
    }

    function setDeniedNullifier(bytes32 nullifier, bool denied) external onlyOwner {
        deniedNullifiers[nullifier] = denied;
    }

    /// @inheritdoc IGroth16Verifier
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata input)
        external
        view
        returns (bool)
    {
        if (!acceptAll) return false;
        if (input.length < 3) revert InvalidInputLength();
        // Vote circuit uses 5 public inputs; nullifier is input[2]. Tally uses a
        // 6-word TALLY_SOL_MOCK_V1 instance and must not share that denylist slot.
        if (input.length == 5 && deniedNullifiers[bytes32(input[2])]) return false;
        return true;
    }
}
