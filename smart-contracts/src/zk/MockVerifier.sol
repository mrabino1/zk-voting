// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IHasher} from "../interfaces/IHasher.sol";
import {DisqualificationSet} from "../tree/DisqualificationSet.sol";
import {EligibleSet} from "../tree/EligibleSet.sol";

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
///
///      Inclusion hook (tests / CI, not a Groth16 check): when a nullifier has
///      an armed witness, `verifyProof` evaluates vote-circuit Merkle inclusion
///      of that leaf under `input[0]`. Unarmed proofs keep `acceptAll`. A coded
///      disqualification removes the leaf from the published eligible root, so
///      the armed witness returns false.
///
///      Non-membership hook: when armed, `verifyProof` also evaluates the
///      indexed-chain gap against `input[1]` (`disqRoot`). A disqualified leaf
///      has no satisfying gap, so the armed proof returns false.
contract MockVerifier is IGroth16Verifier {
    error NotOwner();
    error InvalidInputLength();
    error WitnessLengthMismatch();

    address public immutable owner;
    bool public acceptAll = true;

    /// @notice Optional denylist keyed by `bytes32(nullifier)` (publicInputs[2]).
    mapping(bytes32 => bool) public deniedNullifiers;

    /// @notice Hasher for the optional inclusion hook. Keccak in Foundry tests.
    IHasher public inclusionHasher;

    struct InclusionWitness {
        bool armed;
        uint256 leaf;
        uint256[] pathElements;
        uint8[] pathIndices;
    }

    /// @dev Keyed by the vote nullifier (`publicInputs[2]`), not the identity.
    mapping(uint256 => InclusionWitness) private _inclusionByNullifier;

    struct NonMembershipWitness {
        bool armed;
        uint256 leaf;
        uint256 low;
        uint256 next;
        uint256[] pathElements;
        uint8[] pathIndices;
    }

    mapping(uint256 => NonMembershipWitness) private _nonMembershipByNullifier;

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

    function setInclusionHasher(address hasher_) external onlyOwner {
        inclusionHasher = IHasher(hasher_);
    }

    /// @notice Arm the vote-circuit inclusion witness checked for this nullifier.
    function armInclusionWitness(
        uint256 nullifier,
        uint256 leaf,
        uint256[] calldata pathElements,
        uint8[] calldata pathIndices
    ) external onlyOwner {
        if (pathElements.length != pathIndices.length) revert WitnessLengthMismatch();
        InclusionWitness storage w = _inclusionByNullifier[nullifier];
        w.armed = true;
        w.leaf = leaf;
        delete w.pathElements;
        delete w.pathIndices;
        for (uint256 i; i < pathElements.length; ++i) {
            w.pathElements.push(pathElements[i]);
            if (i < pathIndices.length) w.pathIndices.push(pathIndices[i]);
        }
    }

    function clearInclusionWitness(uint256 nullifier) external onlyOwner {
        delete _inclusionByNullifier[nullifier];
    }

    function inclusionArmed(uint256 nullifier) external view returns (bool) {
        return _inclusionByNullifier[nullifier].armed;
    }

    /// @notice Arm the vote-circuit disqualification non-membership witness.
    ///         `low` / `next` are the indexed-chain gap around `leaf`.
    function armNonMembershipWitness(
        uint256 nullifier,
        uint256 leaf,
        uint256 low,
        uint256 next,
        uint256[] calldata pathElements,
        uint8[] calldata pathIndices
    ) external onlyOwner {
        if (pathElements.length != pathIndices.length) revert WitnessLengthMismatch();
        NonMembershipWitness storage w = _nonMembershipByNullifier[nullifier];
        w.armed = true;
        w.leaf = leaf;
        w.low = low;
        w.next = next;
        delete w.pathElements;
        delete w.pathIndices;
        for (uint256 i; i < pathElements.length; ++i) {
            w.pathElements.push(pathElements[i]);
            w.pathIndices.push(pathIndices[i]);
        }
    }

    function nonMembershipArmed(uint256 nullifier) external view returns (bool) {
        return _nonMembershipByNullifier[nullifier].armed;
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
        if (input.length == 5 && _inclusionByNullifier[input[2]].armed) {
            if (address(inclusionHasher) == address(0)) return false;
            InclusionWitness storage w = _inclusionByNullifier[input[2]];
            if (!EligibleSet.verifyInclusion(w.leaf, w.pathElements, w.pathIndices, input[0], inclusionHasher)) {
                return false;
            }
        }
        if (input.length == 5 && _nonMembershipByNullifier[input[2]].armed) {
            if (address(inclusionHasher) == address(0)) return false;
            NonMembershipWitness storage gap = _nonMembershipByNullifier[input[2]];
            if (
                !DisqualificationSet.verifyNonMembership(
                    gap.leaf, gap.low, gap.next, gap.pathElements, gap.pathIndices, input[1], inclusionHasher
                )
            ) {
                return false;
            }
        }
        return true;
    }
}
