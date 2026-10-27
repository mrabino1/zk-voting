# zk-entropy

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later.

Entropy for zk-voting setup ceremonies, in two parts:

| Part | Folder | What it is |
| --- | --- | --- |
| Library + CLI | [`src/`](./src), [`bin/`](./bin) | Collects randomness (keyboard timing, mouse/touch movement, `crypto.getRandomValues`, timer jitter, optional typed text), mixes it with a SHA-256 accumulator, and gives a portable **entropy string** plus a transcript and its hash. No dependencies; runs in browsers and Node ≥ 20. |
| Ceremony web app | [`ceremony/`](./ceremony) | A small deployable site where many people add entropy. Contributions are chained `H(prev ‖ contribution)`; the public transcript holds hashes and timestamps only. When the admin closes it, it publishes the output string that a zk-voting demo admin pastes at first-run setup. See [`ceremony/README.md`](./ceremony/README.md). |

## Entropy string

```
zke1:<source>:<output 64 hex>:<transcript hash 64 hex>:<check 8 hex>
```

- `source` is `local` (made on one machine) or `ceremony` (a closed public ceremony's output).
- `check` = first 8 hex of `SHA-256("zk-entropy/v1/check|" + source + "|" + output + "|" + transcriptHash)`. It catches typos and truncation when the string is copied by hand; it is not a signature.
- The transcript hash lets anyone match the string to a published transcript.

## CLI

```bash
node zk-entropy/bin/zk-entropy.js generate              # type 64 random keys (timing only); prints a zke1:local:… string
node zk-entropy/bin/zk-entropy.js generate --no-keys --format json --transcript t.json
node zk-entropy/bin/zk-entropy.js validate 'zke1:…'      # or pipe it on stdin; exit code 0 = valid
node zk-entropy/bin/zk-entropy.js verify-transcript https://ceremony.example.org/api/transcript
```

`verify-transcript` recomputes a closed ceremony's chain from its revealed contributions and checks the output, the transcript hash and the entropy string.

## Library

```js
import { EntropyPool, attachCollectors, parseEntropyString } from "./src/index.js";

const pool = new EntropyPool();
const detach = attachCollectors(document, pool, { onEvent: (n) => console.log(n) });
// … user moves the mouse and types …
detach();
const { entropyString, transcript, transcriptHash } = await pool.finalize({ source: "local" });

const check = await parseEntropyString(pasted, { allowHex: true }); // { ok, source, outputHex, transcriptHash } or { ok: false, error }
```

Domain-separated hashing: `zk-entropy/v1/{init,absorb,output,commit}` for the pool and `zk-entropy/ceremony/v1/{genesis,step,final}` for the chain. The local transcript records event counts and an estimate of collected bits, never key codes, coordinates or text.

The demo vendors `src/index.js` as `voting_node/apps/node/public/vendor/zk-entropy.js`; a demo test fails if the two drift. After editing the library run:

```bash
cp zk-entropy/src/index.js voting_node/apps/node/public/vendor/zk-entropy.js
```

## Tests

```bash
cd zk-entropy && npm test          # library + CLI (Node ≥ 20)
cd zk-entropy && npm run test:all  # plus the ceremony app (Node ≥ 22.13, run npm ci in ceremony/ first)
```
