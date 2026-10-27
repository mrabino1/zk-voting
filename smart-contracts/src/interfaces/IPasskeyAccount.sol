// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingAccount} from "./IZkVotingAccount.sol";

interface IPasskeyAccount is IZkVotingAccount {
    error ZeroAddress();
    error NotEntryPoint();
    error InvalidNonce();
    error InvalidSender();
    error InvalidSignature();
    error ExecuteFailed();

    function entryPoint() external view returns (address);

    function credIdHash() external view returns (bytes32);

    function pubX() external view returns (uint256);

    function pubY() external view returns (uint256);

    function ethBackupSigner() external view returns (address);
}
