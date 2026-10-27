// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title IHashScheme
/// @notice Optional version tag on an `IHasher`. Not required by the incremental tree.
interface IHashScheme {
    /// @notice `keccak256` of the scheme name, e.g. `"zk-voting.hash.keccak-dev-v1"`.
    function schemeId() external view returns (bytes32);
}
