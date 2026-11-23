# Auditor CLI

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Independent export + verify pack. Canonical docs: [`docs/AUDITOR.md`](../../docs/AUDITOR.md).

```bash
node tools/auditor/cli.mjs verify --file bundle.json
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1
node tools/auditor/cli.mjs verify-rollup --rpc http://127.0.0.1:8545 --rollup 0x… --election 4   # civic vote, from L1 alone
```

Does **not** read `apps/node/data/`. Choice is never a field in the bundle.
