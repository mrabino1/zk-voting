// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

library Roles {
    bytes32 internal constant PLATFORM_ADMIN_ROLE = keccak256("PLATFORM_ADMIN_ROLE");
    bytes32 internal constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 internal constant CLERK_ROLE = keccak256("CLERK_ROLE");
    bytes32 internal constant DISQUALIFICATION_OFFICER_ROLE = keccak256("DISQUALIFICATION_OFFICER_ROLE");
    bytes32 internal constant TALLY_OPERATOR_ROLE = keccak256("TALLY_OPERATOR_ROLE");
    bytes32 internal constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 internal constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");
    bytes32 internal constant PROVER_ROLE = keccak256("PROVER_ROLE");
}
