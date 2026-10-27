// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {Groth16VerifierAdapter} from "../../src/zk/Groth16VerifierAdapter.sol";
import {UntrustedVote20Verifier} from "./fixtures/UntrustedVote20Verifier.sol";

/// @notice Verifies the committed UNTRUSTED Vote(20) Poseidon proof.
/// @dev Not a ceremony. Not MockVerifier.acceptAll. The proving key is gitignored.
///      Missing files revert GROTH16_KEYS_MISSING.
contract UntrustedVote20Test is Test {
    string internal constant PROOF_PATH = "../circuits/fixtures/untrusted/vote20_proof.json";
    string internal constant PUB_PATH = "../circuits/fixtures/untrusted/vote20_public.json";

    function testUntrustedVote20ProofVerifiesAndRejectsTamper() public {
        if (!vm.exists(PROOF_PATH) || !vm.exists(PUB_PATH)) {
            revert(
                "GROTH16_KEYS_MISSING: circuits/fixtures/untrusted Vote(20) files are absent. Run npm run circuits:setup && npm run circuits:prove. Not MockVerifier.acceptAll. UNTRUSTED, no ceremony."
            );
        }

        string memory proofJson = vm.readFile(PROOF_PATH);
        string memory pubJson = vm.readFile(PUB_PATH);

        uint256[2] memory a = [vm.parseJsonUint(proofJson, ".pi_a[0]"), vm.parseJsonUint(proofJson, ".pi_a[1]")];
        // snarkjs JSON stores G2 limbs opposite the Solidity verifier.
        uint256[2][2] memory b = [
            [vm.parseJsonUint(proofJson, ".pi_b[0][1]"), vm.parseJsonUint(proofJson, ".pi_b[0][0]")],
            [vm.parseJsonUint(proofJson, ".pi_b[1][1]"), vm.parseJsonUint(proofJson, ".pi_b[1][0]")]
        ];
        uint256[2] memory c = [vm.parseJsonUint(proofJson, ".pi_c[0]"), vm.parseJsonUint(proofJson, ".pi_c[1]")];

        uint256[5] memory pub;
        for (uint256 i = 0; i < 5; i++) {
            pub[i] = vm.parseJsonUint(pubJson, string.concat("[", vm.toString(i), "]"));
        }
        // Default demo witness: ballotHash = 7, electionId = 1. Depth 20 is not in the instance.
        assertEq(pub[3], 7);
        assertEq(pub[4], 1);

        UntrustedVote20Verifier verifier = new UntrustedVote20Verifier();
        assertTrue(verifier.verifyProof(a, b, c, pub), "UNTRUSTED Vote(20) proof rejected");

        Groth16VerifierAdapter adapter = new Groth16VerifierAdapter(address(verifier), 5);
        uint256[] memory dynamicPub = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) dynamicPub[i] = pub[i];
        assertTrue(adapter.verifyProof(a, b, c, dynamicPub), "adapter rejected Vote(20) proof");

        dynamicPub[1] = dynamicPub[1] + 1;
        assertFalse(adapter.verifyProof(a, b, c, dynamicPub), "tampered disqRoot accepted");
        pub[0] = pub[0] + 1;
        assertFalse(verifier.verifyProof(a, b, c, pub), "tampered eligible root accepted");
    }
}
