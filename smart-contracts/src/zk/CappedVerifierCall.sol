// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/// @title CappedVerifierCall
/// @notice `verifyProof` as a staticcall that copies one word of returndata.
/// @dev A verifier that reverts or returns a large payload must not expand the
///      caller's memory. A failed call, a short return, and a zero word are
///      all "not accepted". The success word is the ABI encoding of `true`.
library CappedVerifierCall {
    function accepted(
        address verifier,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] memory input
    ) internal view returns (bool) {
        bytes memory payload = abi.encodeWithSelector(IGroth16Verifier.verifyProof.selector, a, b, c, input);
        bool ok;
        uint256 word;
        assembly {
            let ptr := mload(0x40)
            ok := staticcall(gas(), verifier, add(payload, 0x20), mload(payload), ptr, 0x20)
            word := mload(ptr)
        }
        return ok && word == 1;
    }
}
