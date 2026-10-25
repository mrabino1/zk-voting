// Audit H-01 / H-05: Tally instance V2 is 7 words, all reduced mod r.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  serializeTallyPublicInputs,
  parseTallyPublicInputs,
  TALLY_INSTANCE_VERSION,
  SNARK_SCALAR_FIELD,
} = require("..");

test("tally instance is V2 with 7 field words incl. tallyKeyHash", () => {
  const big = (1n << 256n) - 1n;
  const out = serializeTallyPublicInputs({
    electionId: 7,
    acceptedCount: 3,
    countsHash: big,
    ballotRoot: big,
    openingsHash: 5,
    tallyKeyHash: big,
  });
  assert.equal(TALLY_INSTANCE_VERSION, 2n);
  assert.equal(out.length, 7);
  for (const w of out) assert.ok(w < SNARK_SCALAR_FIELD);
  assert.equal(out[3], big % SNARK_SCALAR_FIELD);
  const parsed = parseTallyPublicInputs(out);
  assert.equal(parsed.version, 2n);
  assert.equal(parsed.tallyKeyHash, big % SNARK_SCALAR_FIELD);
  assert.throws(() => parseTallyPublicInputs(out.slice(0, 6)));
});
