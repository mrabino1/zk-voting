// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title ReasonCodes
/// @notice Public catalog of disqualification codes. Codes are visible; evidence is not.
library ReasonCodes {
    uint16 internal constant NONE = 0;
    uint16 internal constant NOT_OF_AGE = 1;
    uint16 internal constant NOT_RESIDENT = 2;
    uint16 internal constant NOT_CITIZEN_OR_MEMBER = 3;
    uint16 internal constant DUPLICATE_IDENTITY = 4;
    uint16 internal constant DECEASED = 5;
    uint16 internal constant MOVED_OUT = 6;
    uint16 internal constant DISTRICT_MISMATCH = 7;
    uint16 internal constant ALREADY_VOTED = 8;
    uint16 internal constant COURT_ORDER = 9;
    uint16 internal constant INELIGIBLE_STATUS = 10;
    uint16 internal constant FRAUD_HOLD = 11;
    uint16 internal constant EXPIRED_OR_SUSPENDED = 12;
    uint16 internal constant SANCTION_OR_PROHIBITION = 13;
    uint16 internal constant OTHER = 14;

    uint16 internal constant MAX_CODE = 14;

    function isValid(uint16 code) internal pure returns (bool) {
        return code >= NOT_OF_AGE && code <= MAX_CODE;
    }
}
