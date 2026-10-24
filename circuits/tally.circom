pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Tally circuit: prove that published per-option counts equal the
// accepted ballots (plaintext / mock-homomorphic path).
//
// =============================================================================
// Public-input versioning (READ THIS BEFORE WIRING A VERIFIER)
// =============================================================================
//
// Circom public signals for this file's default `Tally(8, 4)`
// (`component main {public [electionId, counts, acceptedCount]}`).
// Circom puts **outputs first**:
//
//   CIRCOM_TALLY_V1 (nBallots=8, nOptions=4):
//     [0] total                 // output; constrained == acceptedCount
//     [1] electionId
//     [2] counts[0]
//     [3] counts[1]
//     [4] counts[2]
//     [5] counts[3]
//     [6] acceptedCount
//
// Solidity `Tally.sol` does **not** pass this array. It uses
// `TallyPublicInputs` / TALLY_SOL_MOCK_V1:
//
//     [0] version (1)
//     [1] electionId
//     [2] acceptedCount
//     [3] countsHash     // keccak256(abi.encodePacked(counts))
//     [4] ballotRoot     // inbox hash-chain; 0 on SUM_ONLY
//     [5] openingsHash   // keccak of opened option indices; 0 on SUM_ONLY
//
// These layouts are versioned separately on purpose:
// - Circom fixes nOptions at compile time and exposes counts in the clear.
// - Solidity supports variable-length counts via a hash, plus the
//   opened-ballot bind (ballotRoot / openingsHash).
// Do not generate VoteVerifier-style Solidity from this R1CS and point
// `ElectionParams.verifier` at it without a translating wrapper.
// Foundry tests and local L2 keep MockVerifier.
//
// PRODUCTION: ballots on chain are ElGamal (or similar) ciphertexts.
// A production tally proves a decryption of the product of those
// ciphertexts, or a mixnet + decrypt, with the same Poseidon/elliptic
// hasher as vote.circom. Poseidon is preferred wherever an in-circuit
// hash is required.
//
// MOCK PATH (this file, local L2 / Foundry MockVerifier): after a
// trusted operator decrypts (or when tests use plaintext option
// indices), prove:
//   1. each non-padding ballot is an option index in [0, nOptions)
//   2. counts[j] == #{ ballots with value j }
//   3. sum(counts) == acceptedCount
//   4. electionId is bound as a public input (same id Tally.sol posts)
//
// identity.circom includes Poseidon Hasher(). This tally template does not call it.

include "./identity.circom";

// IsZero / IsEqual — self-contained; do not require circomlib.
template IsZero() {
    signal input in;
    signal output out;
    signal inv;

    inv <-- in != 0 ? 1 / in : 0;
    out <== 1 - in * inv;
    in * out === 0;
}

template IsEqual() {
    signal input in[2];
    signal output out;

    component isz = IsZero();
    isz.in <== in[0] - in[1];
    out <== isz.out;
}

// Tally(nBallots, nOptions)
//
// ballots[i] ∈ {0, …, nOptions-1} is a counted vote.
// ballots[i] == nOptions is padding (not counted). No other values.
//
// Homomorphic note: replacing `ballots[i]` with a decrypted share of
// an ElGamal ciphertext, and proving knowledge of the discrete log,
// is the production path. The summation constraints stay the same.
template Tally(nBallots, nOptions) {
    signal input electionId;
    signal input ballots[nBallots];
    signal input counts[nOptions];
    signal input acceptedCount;

    signal output total;

    // Bind electionId so a proof cannot be replayed against another poll.
    // Dummy quadratic constraint: electionId is in the instance.
    signal electionIdSq;
    electionIdSq <== electionId * electionId;

    // nOptions fits in 8 bits for ZK-Voting v1 (questionCount is uint8;
    // per-question option lists are small). Indices are still field elements.
    var pad = nOptions;

    component isPad[nBallots];
    component isOpt[nBallots][nOptions];
    signal oneHotSum[nBallots];
    signal counted[nBallots];

    for (var i = 0; i < nBallots; i++) {
        isPad[i] = IsEqual();
        isPad[i].in[0] <== ballots[i];
        isPad[i].in[1] <== pad;

        var optAccum = 0;
        for (var j = 0; j < nOptions; j++) {
            isOpt[i][j] = IsEqual();
            isOpt[i][j].in[0] <== ballots[i];
            isOpt[i][j].in[1] <== j;
            optAccum += isOpt[i][j].out;
        }
        oneHotSum[i] <== optAccum;
        // Either exactly one option matches, or this slot is padding.
        oneHotSum[i] + isPad[i].out === 1;
        counted[i] <== oneHotSum[i];
    }

    signal optionAccum[nOptions][nBallots + 1];
    for (var j = 0; j < nOptions; j++) {
        optionAccum[j][0] <== 0;
        for (var i = 0; i < nBallots; i++) {
            optionAccum[j][i + 1] <== optionAccum[j][i] + isOpt[i][j].out;
        }
        optionAccum[j][nBallots] === counts[j];
    }

    signal countSum[nOptions + 1];
    countSum[0] <== 0;
    for (var j = 0; j < nOptions; j++) {
        countSum[j + 1] <== countSum[j] + counts[j];
    }
    total <== countSum[nOptions];
    total === acceptedCount;

    // acceptedCount cannot exceed the witness length.
    signal countedSum[nBallots + 1];
    countedSum[0] <== 0;
    for (var i = 0; i < nBallots; i++) {
        countedSum[i + 1] <== countedSum[i] + counted[i];
    }
    countedSum[nBallots] === acceptedCount;
}

// Small default for circuit tests. Production compiles Tally(N, K) to
// match inbox.acceptedBallots and the ballot spec's option count.
component main {public [electionId, counts, acceptedCount]} = Tally(8, 4);
