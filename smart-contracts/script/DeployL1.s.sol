// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {console2} from "forge-std/Script.sol";
import {DeployOnce} from "./DeployGuard.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {ZkVotingMailbox} from "../src/l2/ZkVotingMailbox.sol";

/// @notice Ethereum (or Sepolia) settlement: rollup, tally mirror, mailbox.
///         `BATCH_VERIFIER` is required (audit H-06). Only with the explicit
///         dev flag `ZK_VOTING_SETTLEMENT_MOCK_MODE=1` and no verifier is the
///         settlement deployed in `mockMode` (proofs not checked).
///         `L2_FACTORY` (or `ELECTION_FACTORY_ADDRESS`) is required so the
///         mirror cannot accept colliding uint256 `postResult` writes.
///         `TALLY_MIRROR_REQUIRE_SETTLED_ROOT=1` pins the settlement in the
///         mirror so posts must cite a settled L2 state root (audit M-05).
contract DeployL1 is DeployOnce {
    error MissingL2Factory();
    error MissingBatchVerifier();

    function run() external {
        _refuseIfAlreadyDeployed();
        vm.startBroadcast();
        address admin = msg.sender;
        address sequencer = vm.envOr("SEQUENCER", admin);
        address prover = vm.envOr("PROVER", admin);
        address batchVerifier = vm.envOr("BATCH_VERIFIER", address(0));

        bool mockSettlement = vm.envOr("ZK_VOTING_SETTLEMENT_MOCK_MODE", false);
        if (batchVerifier == address(0) && !mockSettlement) revert MissingBatchVerifier();
        bool mockMode = batchVerifier == address(0) && mockSettlement;
        if (mockMode) console2.log("WARNING: RollupSettlement in mockMode (ZK_VOTING_SETTLEMENT_MOCK_MODE=1); batches are NOT verified");
        RollupSettlement settlement = new RollupSettlement(admin, sequencer, prover, batchVerifier, mockMode);
        ZkVotingMailbox mailbox = new ZkVotingMailbox(admin);
        L1TallyMirror mirror = new L1TallyMirror(admin, address(mailbox));
        address l2Factory = _factory();
        if (l2Factory == address(0)) revert MissingL2Factory();
        mirror.setL2Factory(l2Factory);
        // Audit M-05 (opt-in): require every certification to cite a settled
        // L2 state root. Off by default because the Node posts a zero root
        // until the sequencer publishes batches.
        if (vm.envOr("TALLY_MIRROR_REQUIRE_SETTLED_ROOT", false)) mirror.setSettlement(address(settlement));
        vm.stopBroadcast();

        _log("SETTLEMENT", address(settlement));
        _log("TALLY_MIRROR", address(mirror));
        _log("MAILBOX", address(mailbox));
        _log("L2_FACTORY", l2Factory);
        _log("BATCH_VERIFIER", batchVerifier);
    }

    function _factory() internal view returns (address) {
        address a = vm.envOr("L2_FACTORY", address(0));
        if (a != address(0)) return a;
        return vm.envOr("ELECTION_FACTORY_ADDRESS", address(0));
    }

    function _log(string memory name, address addr) internal view {
        console2.log(string.concat(name, "=", vm.toString(addr)));
    }
}
