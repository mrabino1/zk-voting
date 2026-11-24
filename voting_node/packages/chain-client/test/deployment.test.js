// NOT FOR PROFIT — civic public good, not a commercial product.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { privateKeyToAccount } = require("viem/accounts");

const { ANVIL_DEV_KEYS, assertKeyAllowedOnChain, isAnvilDevKey, readDeployment } = require("..");

test("the Anvil dev keys are the ten public mnemonic accounts", () => {
  assert.equal(ANVIL_DEV_KEYS.length, 10);
  assert.equal(privateKeyToAccount(ANVIL_DEV_KEYS[0]).address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(privateKeyToAccount(ANVIL_DEV_KEYS[9]).address, "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720");
});

test("a dev key is refused off chain 31337", () => {
  assert.equal(isAnvilDevKey(ANVIL_DEV_KEYS[1].toUpperCase().replace("0X", "")), true);
  assert.doesNotThrow(() => assertKeyAllowedOnChain(ANVIL_DEV_KEYS[1], 31337));
  assert.throws(() => assertKeyAllowedOnChain(ANVIL_DEV_KEYS[1], 1, "ROLLUP_PRIVATE_KEY"), /ROLLUP_PRIVATE_KEY is a public Anvil dev key/);
  assert.doesNotThrow(() => assertKeyAllowedOnChain(`0x${"ab".repeat(32)}`, 1));
  assert.doesNotThrow(() => assertKeyAllowedOnChain("", 1));
});

test("readDeployment reads DeployLocal output and returns null when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkv-deploy-"));
  try {
    assert.equal(readDeployment(path.join(dir, "missing.json")), null);
    const file = path.join(dir, "local.json");
    fs.writeFileSync(file, JSON.stringify({ chainId: 31337, rollup: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", jurisdictionId: `0x${"12".repeat(32)}`, operator: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }));
    const d = readDeployment(file);
    assert.equal(d.rollup, "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0");
    assert.equal(d.chainId, 31337);
    assert.equal(d.clerk, null);
    fs.writeFileSync(file, JSON.stringify({ chainId: 1 }));
    assert.throws(() => readDeployment(file), /no rollup address/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
