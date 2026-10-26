#!/usr/bin/env node
/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-entropy CLI: generate local entropy, validate a pasted string, or verify
 * a closed ceremony transcript.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EntropyPool, parseEntropyString, verifyCeremonyTranscript } from "../src/index.js";

const HELP = `zk-entropy: entropy for zk-voting setup ceremonies

Usage:
  zk-entropy generate [--keys N] [--no-keys] [--text TEXT] [--format string|hex|json] [--transcript FILE]
  zk-entropy validate [STRING]          (reads stdin when STRING is omitted)
  zk-entropy verify-transcript FILE|URL (a closed ceremony's /api/transcript)

generate mixes crypto.getRandomValues, timing jitter, optional --text, and
(when run in a terminal) the timing of N random keystrokes (default 64).
It prints the portable string (zke1:...) on stdout. Nothing is uploaded.
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-keys") out.noKeys = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function collectKeys(pool, n, { input = process.stdin, err = process.stderr } = {}) {
  return new Promise((resolve) => {
    let got = 0;
    err.write(`Type ${n} random keys (they are not shown or stored; only timing is mixed in).\n`);
    input.setRawMode(true);
    input.resume();
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      err.write("\n");
      resolve(got);
    };
    const onData = (buf) => {
      for (const byte of buf) {
        if (byte === 3) {
          // Ctrl-C: stop collecting, keep what we have.
          done();
          return;
        }
        pool.addKeyboardEvent({ time: performance.now(), code: byte });
        got += 1;
        err.write(".");
        if (got >= n) {
          done();
          return;
        }
      }
    };
    input.on("data", onData);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out || process.stdout;
  const err = io.err || process.stderr;
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.help || !cmd) {
    out.write(HELP);
    return cmd || args.help ? 0 : 2;
  }
  if (cmd === "generate") {
    const pool = new EntropyPool();
    const keys = Math.max(0, Number.parseInt(args.keys ?? "64", 10) || 0);
    const interactive = !args.noKeys && keys > 0 && process.stdin.isTTY && !io.noTty;
    if (interactive) await collectKeys(pool, keys, { err });
    if (args.text) pool.addText(args.text);
    pool.addJitter(512);
    const res = await pool.finalize({ source: "local" });
    if (args.transcript) writeFileSync(args.transcript, JSON.stringify({ ...res.transcript, transcriptHash: res.transcriptHash }, null, 2) + "\n");
    const fmt = args.format || "string";
    if (fmt === "hex") out.write(res.outputHex + "\n");
    else if (fmt === "json") out.write(JSON.stringify({ entropyString: res.entropyString, outputHex: res.outputHex, transcriptHash: res.transcriptHash, transcript: res.transcript }, null, 2) + "\n");
    else if (fmt === "string") out.write(res.entropyString + "\n");
    else throw new Error("--format must be string, hex, or json");
    if (!interactive) err.write("note: no keystrokes collected (not a terminal or --no-keys); OS randomness and jitter were used.\n");
    return 0;
  }
  if (cmd === "validate") {
    const value = args._[1] ?? (await (io.readStdin || readStdin)());
    const res = await parseEntropyString(value, { allowHex: args.hex === "allow" });
    if (!res.ok) {
      err.write(`invalid: ${res.error}\n`);
      return 1;
    }
    out.write(`ok source=${res.source}${res.transcriptHash ? ` transcript=${res.transcriptHash}` : ""}\n`);
    return 0;
  }
  if (cmd === "verify-transcript") {
    const where = args._[1];
    if (!where) throw new Error("verify-transcript needs a file or URL");
    const text = /^https?:\/\//.test(where) ? await (await fetch(where)).text() : readFileSync(where, "utf8");
    const body = JSON.parse(text);
    const t = body.transcript || body;
    const res = await verifyCeremonyTranscript(t);
    if (!res.ok) {
      err.write(`transcript does NOT verify: ${res.error}\n`);
      return 1;
    }
    out.write(`transcript verifies: ${t.contributions.length} contributions\n${res.entropyString}\n`);
    return 0;
  }
  err.write(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
  );
}
