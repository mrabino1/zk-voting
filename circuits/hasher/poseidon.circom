pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// HASH_SCHEME: republic.hash.poseidon-bn254-x5-t3-v1
//
// Selected Hasher() for identity.circom / vote.circom. Poseidon(2) over bn254,
// S-box x^5, t=3, the circomlib parameter set. Constants live in
// poseidon_constants_t3.circom (iden3/circomlib C[1], M[1]).
//
// This is the hash. It is not a trusted setup. Local zkeys from
// circuits/scripts/proving-path.mjs stay untrusted until a published ceremony.
//
// The permutation matches packages/proof-helpers/poseidon.js and
// Solidity PoseidonT3.hashLeftRight. Do not mix it with standin-v0 or keccak.

include "./poseidon_constants_t3.circom";

template Sigma() {
    signal input in;
    signal output out;

    signal in2;
    signal in4;
    in2 <== in * in;
    in4 <== in2 * in2;
    out <== in4 * in;
}

template Ark(t, C, r) {
    signal input in[t];
    signal output out[t];

    for (var i = 0; i < t; i++) {
        out[i] <== in[i] + C[i + r];
    }
}

template Mix(t, M) {
    signal input in[t];
    signal output out[t];

    var lc;
    for (var i = 0; i < t; i++) {
        lc = 0;
        for (var j = 0; j < t; j++) {
            lc += M[i][j] * in[j];
        }
        out[i] <== lc;
    }
}

// Poseidon(nInputs). Republic only instantiates nInputs = 2 (t = 3).
template Poseidon(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    // Whitepaper https://eprint.iacr.org/2019/458.pdf , circomlib rounding.
    var N_ROUNDS_P[16] = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];
    var t = nInputs + 1;
    var nRoundsF = 8;
    var nRoundsP = N_ROUNDS_P[t - 2];
    var C[t * (nRoundsF + nRoundsP)] = POSEIDON_C(t);
    var M[t][t] = POSEIDON_M(t);

    component ark[nRoundsF + nRoundsP];
    component sigmaF[nRoundsF][t];
    component sigmaP[nRoundsP];
    component mix[nRoundsF + nRoundsP];

    var k;
    for (var i = 0; i < nRoundsF + nRoundsP; i++) {
        ark[i] = Ark(t, C, t * i);
        for (var j = 0; j < t; j++) {
            if (i == 0) {
                if (j > 0) {
                    ark[i].in[j] <== inputs[j - 1];
                } else {
                    ark[i].in[j] <== 0;
                }
            } else {
                ark[i].in[j] <== mix[i - 1].out[j];
            }
        }

        if (i < nRoundsF / 2 || i >= nRoundsP + nRoundsF / 2) {
            k = i < nRoundsF / 2 ? i : i - nRoundsP;
            mix[i] = Mix(t, M);
            for (var j = 0; j < t; j++) {
                sigmaF[k][j] = Sigma();
                sigmaF[k][j].in <== ark[i].out[j];
                mix[i].in[j] <== sigmaF[k][j].out;
            }
        } else {
            k = i - nRoundsF / 2;
            mix[i] = Mix(t, M);
            sigmaP[k] = Sigma();
            sigmaP[k].in <== ark[i].out[0];
            mix[i].in[0] <== sigmaP[k].out;
            for (var j = 1; j < t; j++) {
                mix[i].in[j] <== ark[i].out[j];
            }
        }
    }

    out <== mix[nRoundsF + nRoundsP - 1].out[0];
}

// HashLeftRight. Same shape as IHasher.hashLeftRight(uint256, uint256).
template Hasher() {
    signal input a;
    signal input b;
    signal output out;

    component p = Poseidon(2);
    p.inputs[0] <== a;
    p.inputs[1] <== b;
    out <== p.out;
}
