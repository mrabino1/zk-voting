// NOT FOR PROFIT — civic public good, not a commercial product.
// Unit tests: capabilities, role-change rules, layout validation/branding,
// plugin manifest + package validation and the defensive zip reader.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  CAPABILITIES,
  capabilitiesOf,
  hasCapability,
  normalizeRoleInput,
  roleChangeError,
} from '../src/capabilities.mjs';
import { resolvePluginUpdateIntervalMs } from '../src/config.mjs';
import { DEFAULT_PRODUCT_NAME, defaultLayout, layoutForAudience, mergeLayout, resolveBranding, safeHref, themeCss, validateLayout } from '../src/layout.mjs';
import { ManifestError, packageChecksum, semverCmp, semverGt, sha256Hex, validateManifest, validatePackage } from '../src/plugins/manifest.mjs';
import { fetchBounded, parseUpdateFeed, verifyPackageSignature } from '../src/plugins/updateFeed.mjs';
import { readZip, safeEntryPath, stripCommonRoot, writeZip, ZipError } from '../src/plugins/zip.mjs';

const user = (role, extra = {}) => ({ id: `u-${role}`, handle: role, role, ...extra });

describe('capabilities', () => {
  test('super admin holds every capability; admin all but manage_admins', () => {
    assert.deepEqual([...capabilitiesOf(user('platform_super_admin'))].sort(), [...CAPABILITIES].sort());
    const admin = capabilitiesOf(user('platform_admin'));
    assert.ok(!admin.includes('manage_admins'));
    for (const c of ['manage_roles', 'manage_plugins', 'edit_layout', 'manage_branding', 'view_audit']) assert.ok(admin.includes(c), c);
  });
  test('designer, election manager, auditor, moderator get narrow capabilities', () => {
    assert.deepEqual([...capabilitiesOf(user('designer'))].sort(), ['access_site_admin', 'edit_layout']);
    assert.ok(hasCapability(user('election_manager'), 'manage_elections'));
    assert.ok(!hasCapability(user('election_manager'), 'edit_layout'));
    assert.ok(hasCapability(user('auditor'), 'view_audit'));
    assert.ok(!hasCapability(user('auditor'), 'manage_roles'));
    assert.ok(hasCapability(user('moderator'), 'moderate_content'));
    assert.ok(!hasCapability(user('designer'), 'manage_branding'));
  });
  test('voters, officers and suspended users get nothing', () => {
    assert.deepEqual(capabilitiesOf(user('voter')), []);
    assert.deepEqual(capabilitiesOf(user('clerk')), []);
    assert.deepEqual(capabilitiesOf(user('platform_super_admin', { suspendedAt: '2026-01-01T00:00:00Z' })), []);
    assert.deepEqual(capabilitiesOf(null), []);
  });
  test('role aliases', () => {
    assert.equal(normalizeRoleInput('super_admin'), 'platform_super_admin');
    assert.equal(normalizeRoleInput('admin'), 'platform_admin');
    assert.equal(normalizeRoleInput('editor'), 'designer');
    assert.equal(normalizeRoleInput('auditor'), 'auditor');
  });
});

describe('roleChangeError', () => {
  const sa = user('platform_super_admin');
  const admin = user('platform_admin');
  test('valid change by super admin', () => {
    assert.equal(roleChangeError({ actor: sa, target: user('voter'), nextRole: 'platform_admin', superAdminCount: 1 }), null);
  });
  test('unknown role → 400', () => {
    assert.equal(roleChangeError({ actor: sa, target: user('voter'), nextRole: 'root', superAdminCount: 1 }).status, 400);
  });
  test('without manage_roles → 403', () => {
    assert.equal(roleChangeError({ actor: user('designer'), target: user('voter'), nextRole: 'auditor', superAdminCount: 1 }).status, 403);
  });
  test('admin cannot touch protected roles', () => {
    assert.equal(roleChangeError({ actor: admin, target: user('voter'), nextRole: 'platform_admin', superAdminCount: 2 }).status, 403);
    assert.equal(roleChangeError({ actor: admin, target: sa, nextRole: 'voter', superAdminCount: 2 }).status, 403);
    assert.equal(roleChangeError({ actor: admin, target: user('voter'), nextRole: 'designer', superAdminCount: 2 }), null);
  });
  test('last super admin cannot be demoted', () => {
    const e = roleChangeError({ actor: sa, target: sa, nextRole: 'platform_admin', superAdminCount: 1 });
    assert.equal(e.status, 409);
    assert.equal(roleChangeError({ actor: sa, target: sa, nextRole: 'platform_admin', superAdminCount: 2 }), null);
  });
});

describe('layout', () => {
  test('defaults: ZK-Voting, unset branding inherits', () => {
    assert.equal(DEFAULT_PRODUCT_NAME, 'ZK-Voting');
    assert.equal(defaultLayout().branding.productName, '');
    assert.equal(validateLayout({}).branding.productName, '');
    assert.equal(resolveBranding(validateLayout({}).branding).productName, 'ZK-Voting');
  });
  test('saved default names (zk-voting, ZK-Voting) count as not renamed', () => {
    assert.equal(validateLayout({ branding: { productName: 'zk-voting' } }).branding.productName, '');
    assert.equal(validateLayout({ branding: { productName: 'ZK-Voting' } }).branding.productName, '');
  });
  test('short name and tagline are plain text with limits', () => {
    const b = validateLayout({ branding: { shortName: ' ZKV ', tagline: 'Vote privately.' } }).branding;
    assert.equal(b.shortName, 'ZKV');
    assert.equal(b.tagline, 'Vote privately.');
    assert.throws(() => validateLayout({ branding: { shortName: 'x'.repeat(25) } }));
    assert.throws(() => validateLayout({ branding: { tagline: 'a "quoted" {brand}' } }));
    const renamed = resolveBranding(validateLayout({ branding: { productName: 'Civic' } }).branding);
    assert.equal(renamed.shortName, 'Civic');
  });
  test('product name is plain text, max 60', () => {
    assert.equal(validateLayout({ branding: { productName: ' My Vote ' } }).branding.productName, 'My Vote');
    assert.throws(() => validateLayout({ branding: { productName: '<script>' } }));
    assert.throws(() => validateLayout({ branding: { productName: 'x'.repeat(61) } }));
  });
  test('mergeLayout layers branding only when renamed', () => {
    const base = defaultLayout();
    assert.equal(mergeLayout(base, validateLayout({ branding: { productName: 'Civic' } })).branding.productName, 'Civic');
    assert.equal(mergeLayout(mergeLayout(base, validateLayout({ branding: { productName: 'Civic' } })), validateLayout({})).branding.productName, 'Civic');
  });
  test('safeHref allows same-origin paths and https only', () => {
    assert.equal(safeHref('/faq'), '/faq');
    assert.equal(safeHref('https://example.org/x'), 'https://example.org/x');
    for (const bad of ['javascript:alert(1)', '//evil.example', 'http://x', 'data:text/html,1', '/\\evil']) {
      assert.throws(() => safeHref(bad), undefined, bad);
    }
  });
  test('theme values are allow-listed and emitted as CSS variables', () => {
    const l = validateLayout({ theme: { light: { focus: '#123456', radius: '6px' }, dark: { fg: '#eeeeee' } } });
    const css = themeCss(mergeLayout(defaultLayout(), l));
    assert.match(css, /--focus:\s*#123456/);
    assert.match(css, /prefers-color-scheme:\s*dark/);
    assert.throws(() => validateLayout({ theme: { light: { fg: 'red;}*{x:y' } } }));
    assert.throws(() => validateLayout({ theme: { light: { nottoken: '#fff' } } }));
  });
  test('audience filtering', () => {
    const l = mergeLayout(
      defaultLayout(),
      validateLayout({
        nav: {
          items: [
            { id: 'a', label: 'All', href: '/a', audience: 'all' },
            { id: 'b', label: 'Admins', href: '/b', audience: 'admin' },
            { id: 'c', label: 'Hidden', href: '/c', visible: false },
          ],
        },
      }),
    );
    assert.deepEqual(layoutForAudience(l, null).nav.items.map((i) => i.id), ['a']);
    assert.deepEqual(layoutForAudience(l, { admin: true }).nav.items.map((i) => i.id), ['a', 'b']);
  });
});

const goodManifest = () => ({
  name: 'demo-plugin',
  version: '1.0.0',
  author: 'A',
  license: 'MIT',
  type: 'both',
  permissions: ['client', 'routes', 'storage'],
  entrypoints: { server: 'server/index.mjs', client: 'client.mjs' },
  hooks: ['routes'],
  slots: ['footer'],
});

describe('plugin manifest', () => {
  test('valid manifest normalises', () => {
    const m = validateManifest(goodManifest(), { appVersion: '0.1.0' });
    assert.equal(m.name, 'demo-plugin');
    assert.equal(m.displayName, 'demo-plugin');
    assert.equal(m.updateUrl, '');
    assert.equal(m.updatePublicKey, '');
  });
  test('optional update source is a credential-free http(s) URL', () => {
    const key = 'ab'.repeat(32);
    const m = validateManifest(
      { ...goodManifest(), updateUrl: 'https://updates.example/feed.json#ignored', updatePublicKey: `ed25519:${key}` },
      { appVersion: '0.1.0' },
    );
    assert.equal(m.updateUrl, 'https://updates.example/feed.json');
    assert.equal(m.updatePublicKey, key);
    for (const updateUrl of ['ftp://updates.example/a', 'javascript:alert(1)', 'http://user:pw@updates.example/a', '/feed.json']) {
      assert.throws(() => validateManifest({ ...goodManifest(), updateUrl }, { appVersion: '0.1.0' }), ManifestError, updateUrl);
    }
    assert.throws(() => validateManifest({ ...goodManifest(), updatePublicKey: 'abcd' }, { appVersion: '0.1.0' }), ManifestError);
  });
  test('semver update comparison is numeric and treats a release as newer than its prerelease', () => {
    assert.equal(semverCmp('1.2.3', '1.2.3'), 0);
    assert.equal(semverGt('1.2.4', '1.2.3'), true);
    assert.equal(semverGt('1.3.0', '1.2.9'), true);
    assert.equal(semverGt('2.0.0', '1.9.9'), true);
    assert.equal(semverGt('1.10.0', '1.9.0'), true);
    assert.equal(semverGt('1.2.3', '1.2.3'), false);
    assert.equal(semverGt('1.0.0', '1.0.1'), false);
    assert.equal(semverGt('1.2.0', '1.2.0-beta.1'), true);
    assert.equal(semverGt('1.2.0-beta.2', '1.2.0-beta.1'), true);
    assert.equal(semverGt('1.2.0-beta.10', '1.2.0-beta.2'), true);
    assert.equal(semverGt('1.2.0-beta.1', '1.2.0'), false);
    assert.equal(semverGt('nope', '1.0.0'), false);
  });
  for (const [label, patch] of [
    ['bad name', { name: 'Bad Name' }],
    ['bad version', { version: '1' }],
    ['bad type', { type: 'kernel' }],
    ['unknown permission', { permissions: ['client', 'routes', 'storage', 'db'] }],
    ['hook without permission', { hooks: ['routes', 'menu'] }],
    ['unknown slot', { slots: ['everywhere'] }],
    ['client without client permission', { permissions: ['routes', 'storage'] }],
    ['entry path traversal', { entrypoints: { server: '../x.mjs', client: 'client.mjs' } }],
    ['missing author', { author: '' }],
    ['missing license', { license: undefined }],
    ['unknown event', { permissions: ['client', 'routes', 'storage', 'events'], hooks: ['routes', 'event:vote.cast'] }],
    ['too new', { minAppVersion: '99.0.0' }],
  ]) {
    test(`rejects ${label}`, () => {
      assert.throws(() => validateManifest({ ...goodManifest(), ...patch }, { appVersion: '0.1.0' }), ManifestError);
    });
  }
});

describe('plugin package', () => {
  const files = (extra = {}, manifest = goodManifest()) =>
    new Map([
      ['plugin.json', Buffer.from(JSON.stringify(manifest))],
      ['server/index.mjs', Buffer.from('export function register(api){ api.routes(); }')],
      ['client.mjs', Buffer.from('export function register(h){}')],
      ...Object.entries(extra).map(([k, v]) => [k, Buffer.from(v)]),
    ]);
  test('valid package', () => {
    assert.equal(validatePackage(files(), { appVersion: '0.1.0' }).name, 'demo-plugin');
  });
  test('missing entrypoint file', () => {
    const f = files();
    f.delete('client.mjs');
    assert.throws(() => validatePackage(f), ManifestError);
  });
  test('disallowed file types and hidden files', () => {
    assert.throws(() => validatePackage(files({ 'run.sh': 'x' })), ManifestError);
    assert.throws(() => validatePackage(files({ 'lib.node': 'x' })), ManifestError);
    assert.throws(() => validatePackage(files({ '.env': 'x' })), ManifestError);
  });
  for (const code of ['eval("1")', 'new Function("a")', 'setTimeout("x()", 1)', 'document.write("x")', 'import("https://cdn.example/x.js")', 'a.href="javascript:void 0"']) {
    test(`CSP scan rejects client code: ${code}`, () => {
      assert.throws(() => validatePackage(files({ 'client.mjs': `export function register(){ ${code} }` })), ManifestError);
    });
  }
  test('checksums must match when declared', () => {
    const m = goodManifest();
    m.checksums = { 'client.mjs': sha256Hex(Buffer.from('export function register(h){}')) };
    assert.ok(validatePackage(files({}, m)));
    m.checksums = { 'client.mjs': sha256Hex(Buffer.from('tampered')) };
    assert.throws(() => validatePackage(files({}, m)), ManifestError);
  });
  test('package checksum is stable and content-sensitive', () => {
    assert.equal(packageChecksum(files()), packageChecksum(files()));
    assert.notEqual(packageChecksum(files()), packageChecksum(files({ 'README.md': 'x' })));
  });
});

describe('zip reader', () => {
  test('round-trips and strips a common root folder', () => {
    const zip = writeZip([
      { name: 'voting_node/plugin.json', data: '{}' },
      { name: 'voting_node/a/b.txt', data: 'hello' },
    ]);
    const files = stripCommonRoot(readZip(zip));
    assert.deepEqual([...files.keys()].sort(), ['a/b.txt', 'plugin.json']);
    assert.equal(files.get('a/b.txt').toString(), 'hello');
  });
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/x.txt', 'a\\b.txt', 'a//b.txt', './a.txt', 'a/\u0000.txt']) {
    test(`zip-slip / unsafe path rejected: ${JSON.stringify(name)}`, () => {
      assert.throws(() => readZip(writeZip([{ name, data: 'x' }])), ZipError);
      assert.throws(() => safeEntryPath(name));
    });
  }
  test('symlinks rejected', () => {
    assert.throws(() => readZip(writeZip([{ name: 'link', data: '/etc/passwd', symlink: true }])), ZipError);
  });
  test('duplicates rejected', () => {
    assert.throws(() => readZip(writeZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }])), ZipError);
  });
  test('size and entry limits', () => {
    assert.throws(() => readZip(writeZip([{ name: 'a.txt', data: 'x'.repeat(100) }]), { maxFileBytes: 10 }), ZipError);
    assert.throws(() => readZip(writeZip([{ name: 'a.txt', data: '1' }, { name: 'b.txt', data: '2' }]), { maxEntries: 1 }), ZipError);
  });
  test('corrupt data rejected', () => {
    const zip = writeZip([{ name: 'a.txt', data: 'hello' }]);
    zip[30 + 5] ^= 0xff; // flip a byte of the stored data → CRC mismatch
    assert.throws(() => readZip(zip), ZipError);
    assert.throws(() => readZip(Buffer.from('not a zip')), ZipError);
  });
});

describe('plugin update feed', () => {
  const feed = (extra = {}) => ({
    version: '1.2.0',
    packageUrl: 'https://updates.example/demo-1.2.0.zip',
    sha256: 'ab'.repeat(32),
    minAppVersion: '0.1.0',
    changelog: 'Fixes contrast',
    ...extra,
  });

  test('parses a feed and ignores a missing signature', () => {
    const parsed = parseUpdateFeed(Buffer.from(JSON.stringify(feed())));
    assert.equal(parsed.version, '1.2.0');
    assert.equal(parsed.signature, null);
    assert.equal(parsed.changelog, 'Fixes contrast');
  });
  test('rejects a feed that is not an object, a bad checksum, or a non-http package URL', () => {
    assert.throws(() => parseUpdateFeed(Buffer.from('[]')), /JSON object/);
    assert.throws(() => parseUpdateFeed(Buffer.from(JSON.stringify(feed({ sha256: 'nope' })))), /sha256/);
    assert.throws(() => parseUpdateFeed(Buffer.from(JSON.stringify(feed({ packageUrl: 'file:///tmp/x.zip' })))), /http/);
    assert.throws(() => parseUpdateFeed(Buffer.from(JSON.stringify(feed({ signature: 'abcd' })))), /signature/);
  });
  test('verifies an ed25519 signature over the package bytes', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const body = Buffer.from('package-bytes');
    const sig = sign(null, body, privateKey);
    assert.equal(verifyPackageSignature(hex, body, sig.toString('hex')), true);
    assert.equal(verifyPackageSignature(hex, body, sig.toString('base64')), true);
    assert.equal(verifyPackageSignature(hex, Buffer.from('other'), sig.toString('hex')), false);
    assert.equal(verifyPackageSignature('cd'.repeat(32), body, sig.toString('hex')), false);
  });
  test('redirects stay on the same host', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://other.example/pkg.zip' } });
    await assert.rejects(
      () => fetchBounded('https://updates.example/feed', { maxBytes: 1000, timeoutMs: 1000, fetchImpl }),
      /same host/,
    );
  });
  test('a same-host redirect is followed', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) return new Response(null, { status: 302, headers: { location: '/pkg.zip' } });
      return new Response(Buffer.from('zip-bytes'), { status: 200 });
    };
    const buf = await fetchBounded('https://updates.example/feed', { maxBytes: 1000, timeoutMs: 1000, fetchImpl });
    assert.equal(buf.toString(), 'zip-bytes');
  });
  test('update interval: default, off, and clamp', () => {
    assert.equal(resolvePluginUpdateIntervalMs(undefined), 12 * 60 * 60 * 1000);
    assert.equal(resolvePluginUpdateIntervalMs('0'), 0);
    assert.equal(resolvePluginUpdateIntervalMs('off'), 0);
    assert.equal(resolvePluginUpdateIntervalMs(1000), 60 * 1000);
    assert.equal(resolvePluginUpdateIntervalMs(2 * 60 * 60 * 1000), 2 * 60 * 60 * 1000);
  });
});
