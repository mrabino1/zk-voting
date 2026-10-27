// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

library Roles {
    /// @notice Host bootstrap. Approves platform admins. Wires factory modules.
    bytes32 internal constant PLATFORM_SUPER_ADMIN_ROLE = keccak256("PLATFORM_SUPER_ADMIN_ROLE");
    /// @notice Platform admin. Approves election staff. Creates jurisdictions.
    bytes32 internal constant PLATFORM_ADMIN_ROLE = keccak256("PLATFORM_ADMIN_ROLE");
    /// @notice Alias of PLATFORM_ADMIN_ROLE for the three-tier approval chain.
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Per-election staff. Adds unbounded external eligibility parties.
    bytes32 internal constant ELECTION_STAFF_ROLE = keccak256("ELECTION_STAFF_ROLE");
    bytes32 internal constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 internal constant CLERK_ROLE = keccak256("CLERK_ROLE");
    bytes32 internal constant DISQUALIFICATION_OFFICER_ROLE = keccak256("DISQUALIFICATION_OFFICER_ROLE");
    bytes32 internal constant TALLY_OPERATOR_ROLE = keccak256("TALLY_OPERATOR_ROLE");
    bytes32 internal constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 internal constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");
    bytes32 internal constant PROVER_ROLE = keccak256("PROVER_ROLE");
}
