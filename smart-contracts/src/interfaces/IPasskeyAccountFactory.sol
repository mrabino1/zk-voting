// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IPasskeyAccountFactory {
    error ZeroAddress();

    /// @notice Emitted when a new account is deployed. `credIdHash` is NOT a vote identity.
    event AccountCreated(address indexed account, bytes32 indexed credIdHash);

    function entryPoint() external view returns (address);

    /// @notice Deploy (or return existing) CREATE2 account for this passkey.
    function createAccount(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt)
        external
        returns (address account);

    /// @notice Deploy (or return existing) CREATE2 account with an explicit backup signer.
    function createAccountWithBackupSigner(
        bytes32 credIdHash,
        uint256 pubX,
        uint256 pubY,
        address ethBackupSigner,
        bytes32 salt
    ) external returns (address account);

    /// @notice Predict the CREATE2 address for these passkey parameters and salt (no backup signer).
    function getAddress(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt) external view returns (address);

    /// @notice Predict the CREATE2 address including the backup signer.
    function getAddressWithBackupSigner(
        bytes32 credIdHash,
        uint256 pubX,
        uint256 pubY,
        address ethBackupSigner,
        bytes32 salt
    ) external view returns (address);
}
