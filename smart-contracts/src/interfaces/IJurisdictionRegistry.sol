// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IJurisdictionRegistry {
    function isClerk(bytes32 jurisdictionId, address account) external view returns (bool);

    function clerkOf(bytes32 jurisdictionId) external view returns (address);
}
