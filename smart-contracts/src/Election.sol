// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, ElectionState} from "./interfaces/ElectionParams.sol";
import {IElection} from "./interfaces/IElection.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";

/// @title Election
/// @notice Cloneable per-election configuration. No upgrades. No fees.
/// @dev Identity commitments live in VoterRegistry; this contract never stores
///      a wallet address as a voter. EIP-1167 clones share code, not storage.
contract Election is IElection {
    error AlreadyInitialized();
    error NotFactory();
    error NotClerk();
    error NotRegistry();
    error ZeroAddress();

    uint256 public electionId;
    address public factory;
    address public voterRegistry;
    address public disqualificationRegistry;
    address public inbox;

    bool public rollFrozen;
    uint256 public participantCount;
    /// @notice Merkle root of registered ∩ ¬currently-disqualified, registration order.
    bytes32 public eligibleRoot;
    /// @notice Append-only disqualification event log. Not the Node's current-DQ tree.
    bytes32 public disqualificationRoot;

    ElectionParams private _params;
    bool private _initialized;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @inheritdoc IElection
    function initialize(
        uint256 electionId_,
        ElectionParams calldata params_,
        address factory_,
        address voterRegistry_,
        address disqualificationRegistry_,
        address inbox_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        _initialized = true;
        electionId = electionId_;
        factory = factory_;
        voterRegistry = voterRegistry_;
        disqualificationRegistry = disqualificationRegistry_;
        inbox = inbox_;
        _params = params_;
    }

    /// @inheritdoc IElection
    function params() external view returns (ElectionParams memory) {
        return _params;
    }

    /// @inheritdoc IElection
    function freezeRoll() external {
        if (msg.sender != _params.clerk) revert NotClerk();
        rollFrozen = true;
    }

    /// @inheritdoc IElection
    function setRoots(bytes32 eligibleRoot_, bytes32 disqualificationRoot_) external {
        if (msg.sender != voterRegistry && msg.sender != disqualificationRegistry) revert NotRegistry();
        eligibleRoot = eligibleRoot_;
        disqualificationRoot = disqualificationRoot_;
    }

    /// @inheritdoc IElection
    function bumpParticipantCount() external {
        if (msg.sender != voterRegistry) revert NotRegistry();
        unchecked {
            participantCount += 1;
        }
    }

    /// @inheritdoc IElection
    /// @dev OPEN = frozen AND now ∈ [start, cutoff). CLOSED after cutoff.
    ///      TALLIED if the wired tally contract reports isTallied.
    function state() external view returns (uint8) {
        address tally = _tally();
        if (tally != address(0)) {
            try ITallyVerifier(tally).isTallied(electionId) returns (bool done) {
                if (done) return ElectionState.TALLIED;
            } catch {}
        }
        if (block.timestamp >= _params.cutoffTime) return ElectionState.CLOSED;
        if (block.timestamp >= _params.startTime && rollFrozen) return ElectionState.OPEN;
        if (rollFrozen) return ElectionState.ROLL_FROZEN;
        return ElectionState.CREATED;
    }

    function _tally() internal view returns (address) {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSignature("tallyVerifier()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address));
        (ok, ret) = factory.staticcall(abi.encodeWithSignature("tally()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (address));
        return address(0);
    }
}
