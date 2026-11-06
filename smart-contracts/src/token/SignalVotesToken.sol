// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {SignalVotes} from "./SignalVotes.sol";

/// @title SignalVotesToken
/// @notice Fixed-supply votes token a host may deploy. There is no owner and no further mint.
/// @dev Holding this token does not register a civic voter. Poll weight is `getPastVotes`
///      at a finalized Ethereum block, and only after the holder delegates.
contract SignalVotesToken is SignalVotes {
    error EmptySupply();

    /// @param recipient Receives `supply` base units. Their voting power stays zero until they delegate.
    /// @param supply Raw base units. The host chooses the number. This contract does not sell tokens.
    constructor(string memory name_, string memory symbol_, address recipient, uint256 supply) {
        if (recipient == address(0)) revert ZeroAddress();
        if (supply == 0) revert EmptySupply();
        _setup(name_, symbol_, 18);
        _mint(recipient, supply);
    }
}
