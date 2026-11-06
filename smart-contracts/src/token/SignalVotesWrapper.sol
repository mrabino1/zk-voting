// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Use this only when the host's token is a plain ERC-20 with no checkpoints.
// Wrapped units are 1:1 with the underlying. They still have zero voting power
// until the holder delegates the wrapped balance. The underlying itself is not
// a voting credential. The node never wraps, unwraps, or delegates for anyone.

import {ISignalUnderlying, SignalVotes} from "./SignalVotes.sol";

/// @title SignalVotesWrapper
/// @notice 1:1 wrapper that adds block-number checkpoints to an existing ERC-20.
contract SignalVotesWrapper is SignalVotes {
    /// @notice Token locked 1:1 against wrapped balances.
    ISignalUnderlying public immutable underlying;

    /// @param underlying_ Must return a boolean from transfer and transferFrom.
    constructor(string memory name_, string memory symbol_, ISignalUnderlying underlying_) {
        if (address(underlying_) == address(0)) revert ZeroAddress();
        underlying = underlying_;
        uint8 d = 18;
        try underlying_.decimals() returns (uint8 got) {
            d = got;
        } catch {}
        _setup(name_, symbol_, d);
    }

    /// @notice Pull `amount` of underlying from the caller and mint wrapped units to `account`.
    /// @dev The caller must approve this contract first. Minting does not delegate.
    function depositFor(address account, uint256 amount) external nonReentrant returns (bool) {
        if (account == address(0)) revert ZeroAddress();
        if (!underlying.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        _mint(account, amount);
        return true;
    }

    /// @notice Burn the caller's wrapped units and send that much underlying to `account`.
    function withdrawTo(address account, uint256 amount) external nonReentrant returns (bool) {
        if (account == address(0)) revert ZeroAddress();
        _burn(msg.sender, amount);
        if (!underlying.transfer(account, amount)) revert TransferFailed();
        return true;
    }
}
