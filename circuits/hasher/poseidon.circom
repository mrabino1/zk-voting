pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// HASH_SCHEME target: republic.hash.poseidon-bn254-x5-t3-v1
//
// This file is intentionally NOT included from identity.circom. Including it
// today would fail (`Hasher` is undefined) until circomlib Poseidon is vendored.
// That is the gate: do not compile a ceremony against hasher/standin.circom
// and call it Poseidon.
//
// When circomlib is in-tree (for example circuits/vendor/circomlib/circuits/poseidon.circom):
//
//   include "../vendor/circomlib/circuits/poseidon.circom";
//   template Hasher() {
//       signal input a;
//       signal input b;
//       signal output out;
//       component p = Poseidon(2);
//       p.inputs[0] <== a;
//       p.inputs[1] <== b;
//       out <== p.out;
//   }
//
// Then switch `include "./hasher/standin.circom"` in identity.circom to this
// file, recompile Vote(treeDepth), and only then run a real powers-of-tau
// plus Groth16 contribution. Local `circuits/scripts/proving-path.mjs setup`
// remains UNTRUSTED even after that swap until an independent ceremony is published.
