#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Runner-stage import check. The image build runs this after copying
// node_modules and apps/node/node_modules. It loads modules the way
// `node src/server.mjs` does and exits non-zero if any import is missing.
//
// Resolves from the importing file, not from this script, so a package
// nested under apps/node/node_modules is visible and a different copy at
// the root is not accepted for that nested install.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const entry = path.join(repoRoot, 'apps/node/src/server.mjs');
const lockPath = path.join(repoRoot, 'package-lock.json');

// Boot imports that must show up in the static graph. The walk also
// imports every other bare specifier it finds.
const REQUIRED_FROM_ENTRY = [
  '@simplewebauthn/server',
  '@simplewebauthn/server/helpers',
  '@noble/curves/p256',
  '@aws-sdk/client-sesv2',
  '@zk-voting/chain-client',
  '@zk-voting/proof-helpers',
  'cors',
  'express',
  'pg',
  'snarkjs',
  'viem',
  'viem/accounts',
];

const PARSE_EXT = new Set(['.mjs', '.js', '.cjs']);

function fail(message) {
  console.error(`image import smoke: ${message}`);
  process.exit(1);
}

function inRepo(file) {
  const rel = path.relative(repoRoot, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function inNodeModules(file) {
  return file.split(path.sep).includes('node_modules');
}

function stripComments(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    out += c;
    if (c === state) state = 'code';
    i += 1;
  }
  return out;
}

function isModuleSpecifier(spec) {
  if (!spec || /\s/.test(spec)) return false;
  if (spec.startsWith('node:')) return true;
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    return !/[()[\]{}|\\^$]/.test(spec);
  }
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]+)?$/i.test(spec);
}

function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      if (isModuleSpecifier(match[1])) specs.push(match[1]);
    }
  }
  return specs;
}

function resolveFrom(spec, fromFile) {
  // import.meta.resolve is anchored to this script, so it never sees
  // apps/node/node_modules. createRequire uses the importing file.
  return createRequire(fromFile).resolve(spec);
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(
      `${base}.mjs`,
      `${base}.js`,
      `${base}.cjs`,
      `${base}.json`,
      path.join(base, 'index.mjs'),
      path.join(base, 'index.js'),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }
  fail(`cannot resolve ${spec} from ${path.relative(repoRoot, fromFile)}`);
}

function owningPackage(file) {
  let dir = path.dirname(file);
  const root = path.parse(dir).root;
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (json.name) return { dir, json };
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function productionNestedPackages(lock) {
  const prefix = 'apps/node/node_modules/';
  const found = [];
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key.startsWith(prefix) || !meta || meta.dev === true) continue;
    const name = key.slice(prefix.length);
    if (!name || name.includes('/node_modules/') || !meta.version) continue;
    found.push({ name, version: String(meta.version) });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

function collectEntrySpecifiers() {
  if (!fs.existsSync(entry)) fail(`missing app entry ${entry}`);
  const specs = new Map();
  const seen = new Set();

  function walk(file) {
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    if (!inRepo(real)) fail(`import escapes the repo: ${real}`);
    if (inNodeModules(real)) return;
    if (!PARSE_EXT.has(path.extname(real))) return;
    const source = stripComments(fs.readFileSync(real, 'utf8'));
    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        walk(resolveRelative(real, spec));
        continue;
      }
      if (!specs.has(spec)) specs.set(spec, real);
      let resolved;
      try {
        resolved = resolveFrom(spec, real);
      } catch {
        continue;
      }
      if (!fs.existsSync(resolved)) continue;
      const resolvedReal = fs.realpathSync(resolved);
      if (!inNodeModules(resolvedReal)) walk(resolvedReal);
    }
  }

  walk(entry);
  return specs;
}

async function importSpecifier(spec, fromFile, seenUrls) {
  let resolved;
  try {
    resolved = resolveFrom(spec, fromFile);
  } catch (err) {
    return `${spec} (from ${path.relative(repoRoot, fromFile)}): ${err.message}`;
  }
  if (seenUrls.has(resolved)) return null;
  seenUrls.add(resolved);
  try {
    await import(pathToFileURL(resolved).href);
  } catch (err) {
    return `${spec} (from ${path.relative(repoRoot, fromFile)}): ${err.message}`;
  }
  return null;
}

async function main() {
  const specs = collectEntrySpecifiers();
  const missingFromGraph = REQUIRED_FROM_ENTRY.filter((spec) => !specs.has(spec));
  if (missingFromGraph.length > 0) {
    fail(
      `app entry graph did not include ${missingFromGraph.join(', ')}. ` +
        `The walker has to see these boot imports.`,
    );
  }

  const failures = [];
  const seenUrls = new Set();
  const ordered = [...specs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [spec, fromFile] of ordered) {
    const error = await importSpecifier(spec, fromFile, seenUrls);
    if (error) failures.push(error);
  }

  if (!fs.existsSync(lockPath)) fail(`missing ${lockPath}`);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const nested = productionNestedPackages(lock);
  for (const { name, version } of nested) {
    const expectedDir = path.join(repoRoot, 'apps/node/node_modules', name);
    if (!fs.existsSync(expectedDir)) {
      failures.push(`${name}@${version} is missing from apps/node/node_modules`);
      continue;
    }
    // Prefer the specifier the app actually loads. @noble/curves has no
    // root entry; guardians import @noble/curves/p256.
    const spec =
      [...specs.keys()].find((item) => item === name || item.startsWith(`${name}/`)) || name;
    const fromFile = specs.get(spec) || entry;
    let resolved;
    try {
      resolved = resolveFrom(spec, fromFile);
    } catch (err) {
      failures.push(`${name}@${version}: ${err.message}`);
      continue;
    }
    const owner = owningPackage(resolved);
    if (!owner) {
      failures.push(`${name}@${version} resolved to ${resolved} without a package.json`);
      continue;
    }
    const actualDir = fs.realpathSync(owner.dir);
    const expectedReal = fs.realpathSync(expectedDir);
    if (actualDir !== expectedReal) {
      failures.push(
        `${name} resolved to ${actualDir} (version ${owner.json.version}); ` +
          `npm ci installed ${version} at ${expectedReal}`,
      );
      continue;
    }
    if (String(owner.json.version) !== version) {
      failures.push(
        `${name} at ${actualDir} is ${owner.json.version}; lockfile installed ${version}`,
      );
      continue;
    }
    const error = await importSpecifier(spec, fromFile, seenUrls);
    if (error) failures.push(error);
  }

  if (failures.length > 0) {
    console.error('image import smoke failed:');
    for (const error of failures) console.error(`  ${error}`);
    process.exit(1);
  }

  console.log(`image import smoke ok (${ordered.length} entry specifiers)`);
  for (const [spec] of ordered) console.log(`  ${spec}`);
  console.log(`nested production packages: ${nested.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
