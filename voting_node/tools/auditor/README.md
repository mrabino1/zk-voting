# Auditor CLI

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Independent export + verify pack. Canonical docs: [`docs/AUDITOR.md`](../../docs/AUDITOR.md).

```bash
node tools/auditor/cli.mjs verify --file bundle.json
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1
node tools/auditor/cli.mjs export-chain --rpc http://127.0.0.1:8545 --factory 0x… --election 1
```

Does **not** read `apps/node/data/`. Choice is never a field in the bundle.
