// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {UserOp} from "./UserOp.sol";

interface IZkVotingAccount {
    function validateUserOp(UserOp calldata op, bytes32 userOpHash) external returns (bool);

    function execute(address dest, uint256 value, bytes calldata data) external;

    function nonce() external view returns (uint256);
}
