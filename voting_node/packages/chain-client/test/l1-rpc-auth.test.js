/**
 * @fileoverview L1 JSON-RPC bearer token on the shared chain client.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, test } = require("node:test");

const { readResultHash, readL1Env } = require("../l1");

const TOKEN = "test-token";
const MIRROR = "0x" + "22".repeat(20);

function listen(result) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization });
      const body = result(requests.length);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

describe("L1 RPC auth on chain-client", () => {
  test("readL1Env keeps a blank token out of the header set", () => {
    assert.equal(readL1Env({}).authToken, "");
    assert.equal(readL1Env({ L1_RPC_AUTH_TOKEN: "   " }).authToken, "");
    assert.equal(readL1Env({ L1_RPC_AUTH_TOKEN: TOKEN }).authToken, TOKEN);
  });

  test("eth_call sends Authorization only when the token is set", async () => {
    const word = "0x" + "ab".repeat(32);
    const authed = await listen(() => ({ jsonrpc: "2.0", id: 1, result: word }));
    const open = await listen(() => ({ jsonrpc: "2.0", id: 1, result: word }));
    try {
      const withToken = await readResultHash(MIRROR, 1, {
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
        rpcUrl: authed.url,
        mirrorAddress: MIRROR,
      });
      assert.equal(withToken, word);
      assert.equal(authed.requests.length, 1);
      assert.equal(authed.requests[0].authorization, `Bearer ${TOKEN}`);

      const without = await readResultHash(MIRROR, 1, {
        env: {},
        rpcUrl: open.url,
        mirrorAddress: MIRROR,
      });
      assert.equal(without, word);
      assert.equal(open.requests.length, 1);
      assert.equal(open.requests[0].authorization, undefined);
    } finally {
      await authed.close();
      await open.close();
    }
  });

  test("an explicit empty authToken wins over the env token", async () => {
    const word = "0x" + "cd".repeat(32);
    const server = await listen(() => ({ jsonrpc: "2.0", id: 1, result: word }));
    try {
      await readResultHash(MIRROR, 1, {
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
        authToken: "",
        rpcUrl: server.url,
        mirrorAddress: MIRROR,
      });
      assert.equal(server.requests[0].authorization, undefined);
    } finally {
      await server.close();
    }
  });

  test("RPC error text does not include the token", async () => {
    const server = await listen(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { message: `denied ${TOKEN}` },
    }));
    try {
      await assert.rejects(
        () =>
          readResultHash(MIRROR, 1, {
            env: { L1_RPC_AUTH_TOKEN: TOKEN },
            rpcUrl: server.url,
            mirrorAddress: MIRROR,
          }),
        (err) => {
          assert.equal(String(err.message).includes(TOKEN), false);
          assert.match(err.message, /\[redacted\]/);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });
});
