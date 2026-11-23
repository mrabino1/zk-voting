// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";

import {ZkVotingRollup} from "../src/ZkVotingRollup.sol";
import {DesertVerifier} from "../src/verifiers/DesertVerifier.sol";
import {MockBatchVerifier} from "../src/verifiers/MockBatchVerifier.sol";

/// @notice Local Anvil deploy (chain id 31337 only): the rollup with the mock batch verifier,
///         the deployer as governor and operator, and one sample jurisdiction whose admin and
///         clerk are the deployer. Writes `deployments/local.json`.
///
///         forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    error LocalChainOnly();

    function run() external returns (ZkVotingRollup rollup) {
        if (block.chainid != 31337) revert LocalChainOnly();
        uint256 key =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(key);
        bytes32 jurisdictionId = vm.envOr("JURISDICTION_ID", keccak256("local"));

        vm.startBroadcast(key);
        DesertVerifier desert = new DesertVerifier();
        MockBatchVerifier mock = new MockBatchVerifier();
        rollup = new ZkVotingRollup(deployer, mock, desert);
        rollup.setOperator(deployer, true);
        rollup.createJurisdiction(jurisdictionId, deployer, "Local");
        rollup.setClerk(jurisdictionId, deployer, true);
        vm.stopBroadcast();

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "batchVerifier", address(mock));
        vm.serializeAddress(json, "desertVerifier", address(desert));
        vm.serializeBytes32(json, "jurisdictionId", jurisdictionId);
        string memory out = vm.serializeAddress(json, "rollup", address(rollup));
        vm.writeJson(out, "deployments/local.json");
        console2.log("ZkVotingRollup", address(rollup));
    }
}
