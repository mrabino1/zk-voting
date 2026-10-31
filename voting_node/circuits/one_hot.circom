pragma circom 2.1.9;

// One-hot ElGamal under a Baby Jubjub joint key.
// Each used option is Enc(0) or Enc(1). Used messages sum to 1.
// n = 0 means the primary ciphertext itself is Enc(0) or Enc(1).
// n > 0 means the primary ciphertext is the sum of the option ciphertexts.
// Randomness is a private scalar below 2^253. The base point is Base8.

include "vendor/circomlib/circuits/bitify.circom";
include "vendor/circomlib/circuits/escalarmulany.circom";

template OneHotIsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in != 0 ? 1 / in : 0;
    out <== -in * inv + 1;
    in * out === 0;
}

template EncryptedBit() {
    signal input r;
    signal input b;
    signal input pkx;
    signal input pky;

    signal output c1x;
    signal output c1y;
    signal output c2x;
    signal output c2y;

    // Base8.
    var gx = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    var gy = 16950150798460657717958625567821834550301663161624707787222815936182638968203;

    signal bitGate;
    bitGate <== b * (b - 1);
    bitGate === 0;

    component rBits = LibNum2Bits(253);
    rBits.in <== r;

    component c1 = EscalarMulAny(253);
    c1.p[0] <== gx;
    c1.p[1] <== gy;
    component pkMul = EscalarMulAny(253);
    pkMul.p[0] <== pkx;
    pkMul.p[1] <== pky;
    for (var i = 0; i < 253; i++) {
        c1.e[i] <== rBits.out[i];
        pkMul.e[i] <== rBits.out[i];
    }

    // b * G, with identity (0, 1) when b is 0.
    signal msgX;
    signal msgY;
    msgX <== b * gx;
    msgY <== b * gy + (1 - b);

    component body = BabyAdd();
    body.x1 <== pkMul.out[0];
    body.y1 <== pkMul.out[1];
    body.x2 <== msgX;
    body.y2 <== msgY;

    c1x <== c1.out[0];
    c1y <== c1.out[1];
    c2x <== body.xout;
    c2y <== body.yout;
}

// n in 0..4. Option slots at and after n are zero and are not messages.
template OneHotVector() {
    signal input pkx;
    signal input pky;
    signal input c1x;
    signal input c1y;
    signal input c2x;
    signal input c2y;
    signal input n;
    signal input optionC1x[4];
    signal input optionC1y[4];
    signal input optionC2x[4];
    signal input optionC2y[4];
    signal input optionR[4];
    signal input optionB[4];
    signal input primaryR;
    signal input primaryB;

    component nZero = OneHotIsZero();
    nZero.in <== n;
    signal hotSum[5];
    hotSum[0] <== nZero.out;
    component step[4];
    signal shifted[4];
    for (var j = 1; j <= 4; j++) {
        shifted[j - 1] <== n - j;
        step[j - 1] = OneHotIsZero();
        step[j - 1].in <== shifted[j - 1];
        hotSum[j] <== hotSum[j - 1] + step[j - 1].out;
    }
    hotSum[4] === 1;

    signal use[4];
    component opt[4];
    signal bitAcc[5];
    bitAcc[0] <== 0;
    // Running sum of used option ciphertexts. Identity is (0, 1).
    signal acc1x[5];
    signal acc1y[5];
    signal acc2x[5];
    signal acc2y[5];
    acc1x[0] <== 0;
    acc1y[0] <== 1;
    acc2x[0] <== 0;
    acc2y[0] <== 1;
    component add1[4];
    component add2[4];
    signal weighted[4];
    signal take1x[4];
    signal keep1x[4];
    signal take1y[4];
    signal keep1y[4];
    signal take2x[4];
    signal keep2x[4];
    signal take2y[4];
    signal keep2y[4];
    for (var k = 0; k < 4; k++) {
        use[k] <== 1 - hotSum[k];
        (1 - use[k]) * optionC1x[k] === 0;
        (1 - use[k]) * optionC1y[k] === 0;
        (1 - use[k]) * optionC2x[k] === 0;
        (1 - use[k]) * optionC2y[k] === 0;

        opt[k] = EncryptedBit();
        opt[k].r <== optionR[k];
        opt[k].b <== optionB[k];
        opt[k].pkx <== pkx;
        opt[k].pky <== pky;
        use[k] * (optionC1x[k] - opt[k].c1x) === 0;
        use[k] * (optionC1y[k] - opt[k].c1y) === 0;
        use[k] * (optionC2x[k] - opt[k].c2x) === 0;
        use[k] * (optionC2y[k] - opt[k].c2y) === 0;

        weighted[k] <== use[k] * optionB[k];
        bitAcc[k + 1] <== bitAcc[k] + weighted[k];

        add1[k] = BabyAdd();
        add1[k].x1 <== acc1x[k];
        add1[k].y1 <== acc1y[k];
        add1[k].x2 <== opt[k].c1x;
        add1[k].y2 <== opt[k].c1y;
        take1x[k] <== use[k] * add1[k].xout;
        keep1x[k] <== (1 - use[k]) * acc1x[k];
        take1y[k] <== use[k] * add1[k].yout;
        keep1y[k] <== (1 - use[k]) * acc1y[k];
        acc1x[k + 1] <== take1x[k] + keep1x[k];
        acc1y[k + 1] <== take1y[k] + keep1y[k];

        add2[k] = BabyAdd();
        add2[k].x1 <== acc2x[k];
        add2[k].y1 <== acc2y[k];
        add2[k].x2 <== opt[k].c2x;
        add2[k].y2 <== opt[k].c2y;
        take2x[k] <== use[k] * add2[k].xout;
        keep2x[k] <== (1 - use[k]) * acc2x[k];
        take2y[k] <== use[k] * add2[k].yout;
        keep2y[k] <== (1 - use[k]) * acc2y[k];
        acc2x[k + 1] <== take2x[k] + keep2x[k];
        acc2y[k + 1] <== take2y[k] + keep2y[k];
    }

    // n = 0: no option messages. n > 0: the messages sum to 1.
    nZero.out * bitAcc[4] === 0;
    (1 - nZero.out) * (bitAcc[4] - 1) === 0;

    component primary = EncryptedBit();
    primary.r <== primaryR;
    primary.b <== primaryB;
    primary.pkx <== pkx;
    primary.pky <== pky;

    // n = 0 checks the primary encryption. n > 0 checks it equals the option sum.
    nZero.out * (c1x - primary.c1x) === 0;
    nZero.out * (c1y - primary.c1y) === 0;
    nZero.out * (c2x - primary.c2x) === 0;
    nZero.out * (c2y - primary.c2y) === 0;
    (1 - nZero.out) * (c1x - acc1x[4]) === 0;
    (1 - nZero.out) * (c1y - acc1y[4]) === 0;
    (1 - nZero.out) * (c2x - acc2x[4]) === 0;
    (1 - nZero.out) * (c2y - acc2y[4]) === 0;
}
