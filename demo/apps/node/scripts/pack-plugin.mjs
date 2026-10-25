#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Pack a plugin folder into a zip that Site admin → Plugins accepts.
//   node apps/node/scripts/pack-plugin.mjs plugins/announcement-banner [out.zip]
// Validates the manifest and client code exactly like the server does and
// prints the SHA-256 the upload form sends as x-plugin-sha256.

import fs from 'node:fs';
import path from 'node:path';

import { readPluginDir } from '../src/plugins/manager.mjs';
import { packageChecksum, sha256Hex, validatePackage } from '../src/plugins/manifest.mjs';
import { writeZip } from '../src/plugins/zip.mjs';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: pack-plugin.mjs <plugin-dir> [out.zip]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const files = await readPluginDir(dir);
const manifest = validatePackage(files);
const out = path.resolve(outArg || `${manifest.name}-${manifest.version}.zip`);
const zip = writeZip([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => ({ name: `${manifest.name}/${name}`, data })));
fs.writeFileSync(out, zip);
console.log(`${out}\n  files: ${files.size}\n  zip sha256: ${sha256Hex(zip)}\n  package checksum: ${packageChecksum(files)}`);
