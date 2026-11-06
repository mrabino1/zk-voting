// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Deploys the optional votes token, or the wrapper around an existing ERC-20.
// Ethereum mainnet is the only production chain. This script does not register
// voters and does not touch the civic election contracts.
//
//   DEPLOYER_PRIVATE_KEY   required
//   TOKEN_NAME             required
//   TOKEN_SYMBOL           required
//   DEPLOY_WRAPPER         false (default) deploys SignalVotesToken
//   INITIAL_RECIPIENT      required when DEPLOY_WRAPPER is false
//   INITIAL_SUPPLY         raw base units, required when DEPLOY_WRAPPER is false
//   UNDERLYING_TOKEN       required when DEPLOY_WRAPPER is true
//
// Writes deployments/<chainId>.json. The node then points VOTING_TOKEN_ADDRESS
// at that address and VOTING_TOKEN_START_BLOCK at the deployment block.

import {Script, console2} from "forge-std/Script.sol";
import {ISignalUnderlying} from "../src/token/SignalVotes.sol";
import {SignalVotesToken} from "../src/token/SignalVotesToken.sol";
import {SignalVotesWrapper} from "../src/token/SignalVotesWrapper.sol";

contract DeploySignalToken is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory tokenName = vm.envString("TOKEN_NAME");
        string memory tokenSymbol = vm.envString("TOKEN_SYMBOL");
        bool wrapper = vm.envOr("DEPLOY_WRAPPER", false);

        vm.startBroadcast(pk);
        address deployed;
        if (wrapper) {
            SignalVotesWrapper wrapped = new SignalVotesWrapper(
                tokenName, tokenSymbol, ISignalUnderlying(vm.envAddress("UNDERLYING_TOKEN"))
            );
            deployed = address(wrapped);
        } else {
            SignalVotesToken token = new SignalVotesToken(
                tokenName, tokenSymbol, vm.envAddress("INITIAL_RECIPIENT"), vm.envUint("INITIAL_SUPPLY")
            );
            deployed = address(token);
        }
        vm.stopBroadcast();

        console2.log("SignalVotes", deployed);
        console2.log("chainId", block.chainid);
        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"address":"',
            vm.toString(deployed),
            '","wrapper":',
            wrapper ? "true" : "false",
            ',"clock":"blocknumber","network":"ethereum-mainnet"}'
        );
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
    }
}
