// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @notice Test-only stand-in for the RIP-7212 precompile at 0x100. The Foundry
///         EVM version used by this repo (cancun) has no P-256 precompile, so
///         tests sign real P-256 signatures with `vm.signP256` and register the
///         exact 160-byte input here. Any other input (wrong message hash,
///         wrong challenge, wrong key) returns empty data, like the precompile.
contract P256PrecompileOracle {
    mapping(bytes32 => bool) public valid;

    function allow(bytes calldata input) external {
        valid[keccak256(input)] = true;
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length == 160 && valid[keccak256(input)]) return abi.encode(uint256(1));
        return "";
    }
}
