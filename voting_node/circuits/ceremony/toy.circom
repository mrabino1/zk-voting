pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// One-constraint circuit used only by the phase-2 ceremony CI drill
// (`npm run circuits:ceremony:toy`). Not the vote circuit, not an election
// depth, and not a trusted setup. See docs/CEREMONY.md.

template Square() {
    signal input x;
    signal output y;
    y <== x * x;
}

component main = Square();
