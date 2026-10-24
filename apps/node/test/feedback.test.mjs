// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { getConfig, resolveFeedbackRateWindow } from '../src/config.mjs';
import { renderFeedbackEmail } from '../src/feedbackMail.mjs';
import { createApp } from '../src/server.mjs';
import { getTermsDocument } from '../src/terms.mjs';
import { SUPPORTED_LOCALES, catalogs, resetLocaleForTests, t } from '../public/i18n.js';

function listen(application) {
  return new Promise((resolve, reject) => {
    const server = application.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function boot(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-feedback-'));
  let now = 1_700_000_000_000;
  let created;
  try {
    created = await createApp({
      dataDir: dir,
      feedbackNowMs: () => now,
      feedbackClientIp: (req) => String(req.headers['x-test-ip'] || '203.0.113.10'),
      superAdminEmail: '',
      ...overrides,
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...created,
    dir,
    server,
    base,
    setNow(value) {
      now = value;
    },
    now() {
      return now;
    },
  };
}

async function closeApp(app) {
  if (app?.server) {
    await new Promise((resolve, reject) => {
      app.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  if (app?.dir) await rm(app.dir, { recursive: true, force: true });
}

async function api(app, body, { ip = '203.0.113.10', headers = {} } = {}) {
  const res = await fetch(`${app.base}/api/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-ip': ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, res };
}

function payload(app, extra = {}) {
  return {
    name: 'Ada',
    replyTo: 'ada@example.gov',
    category: 'general',
    message: 'Please keep the receipt page not for profit.',
    assignmentAccepted: true,
    website: '',
    startedAt: app.now() - 10_000,
    ...extra,
  };
}

async function setOperator(store, email) {
  const user = store.listUsers().find((row) => row.role === 'platform_super_admin');
  assert.ok(user, 'seeded platform super admin');
  user.contactEmail = email;
  user.email = null;
  await store.persist();
  return user;
}

describe('feedback rate window', () => {
  test('defaults to one hour and cannot be shorter', () => {
    assert.equal(resolveFeedbackRateWindow(undefined), 3600);
    assert.equal(resolveFeedbackRateWindow(''), 3600);
    assert.equal(resolveFeedbackRateWindow(60), 3600);
    assert.equal(resolveFeedbackRateWindow('1'), 3600);
    assert.equal(resolveFeedbackRateWindow(7200), 7200);
    assert.equal(getConfig({ feedbackRateWindowSeconds: 30 }).feedbackRateWindowSeconds, 3600);
    assert.equal(getConfig({ feedbackRateWindowSeconds: 7200 }).feedbackRateWindowSeconds, 7200);
  });
});

describe('POST /api/feedback', { concurrency: false }, () => {
  test('requires the assignment checkbox and does not burn the hourly slot', async () => {
    const app = await boot();
    try {
      await setOperator(app.store, 'operator@example.gov');
      const rejected = await api(app, payload(app, { assignmentAccepted: false }));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.json.code, 'ASSIGNMENT_REQUIRED');
      assert.match(rejected.json.error, /property of the project's legal owner/);
      assert.equal(app.mailer.lastFeedback(), null);

      const ok = await api(app, payload(app));
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.termsVersion, '2');
      assert.equal(ok.json.termsPdfSha256, getTermsDocument().pdfSha256);
      assert.equal(app.mailer.lastFeedback().to, 'operator@example.gov');
    } finally {
      await closeApp(app);
    }
  });

  test('honeypot and a too-fast submit do not burn quota for this IP or another', async () => {
    const app = await boot();
    try {
      await setOperator(app.store, 'operator@example.gov');
      const trap = await api(app, payload(app, { website: 'http://spam.example' }), { ip: '203.0.113.20' });
      assert.equal(trap.status, 400);
      assert.equal(trap.json.code, 'HONEYPOT');
      assert.equal(app.mailer.lastFeedback(), null);

      const fast = await api(app, payload(app, { startedAt: app.now() }), { ip: '203.0.113.20' });
      assert.equal(fast.status, 400);
      assert.equal(fast.json.code, 'TOO_FAST');

      const same = await api(app, payload(app), { ip: '203.0.113.20' });
      assert.equal(same.status, 200);
      const other = await api(app, payload(app), { ip: '203.0.113.21' });
      assert.equal(other.status, 200);
    } finally {
      await closeApp(app);
    }
  });

  test('allows one submit per IP per hour, with Retry-After and a friendly wait', async () => {
    const app = await boot();
    try {
      await setOperator(app.store, 'operator@example.gov');
      const first = await api(app, payload(app), { ip: '198.51.100.10' });
      assert.equal(first.status, 200, first.text);

      app.setNow(app.now() + 120_000);
      const second = await api(app, payload(app), { ip: '198.51.100.10' });
      assert.equal(second.status, 429);
      assert.equal(second.res.headers.get('retry-after'), '3480');
      assert.equal(second.json.retryAfterSeconds, 3480);
      assert.equal(second.json.minutes, 58);
      assert.equal(second.json.error, 'You can send another message in about 58 minutes');
      assert.equal(app.mailer.sent.filter((row) => row.meta?.purpose === 'feedback').length, 1);

      const neighbor = await api(app, payload(app), { ip: '198.51.100.11' });
      assert.equal(neighbor.status, 200);

      app.setNow(1_700_000_000_000 + 3_600_000);
      const again = await api(app, payload(app), { ip: '198.51.100.10' });
      assert.equal(again.status, 200, again.text);
    } finally {
      await closeApp(app);
    }
  });

  test('escapes HTML and refuses header injection in Reply-To', async () => {
    const app = await boot();
    const lines = [];
    const orig = console.info;
    console.info = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    const needle = 'NEEDLE_do_not_log_<script>alert(1)</script> & "quoted"';
    try {
      await setOperator(app.store, 'operator@example.gov');
      const badReply = await api(
        app,
        payload(app, { replyTo: 'ada@example.gov\r\nBcc: evil@evil.test', message: needle }),
      );
      assert.equal(badReply.status, 400);
      assert.equal(badReply.json.code, 'VALIDATION');
      assert.equal(app.mailer.lastFeedback(), null);

      const sent = await api(
        app,
        payload(app, {
          name: 'Ada\r\nBcc: evil@evil.test',
          replyTo: 'Person@Example.Gov',
          message: needle,
          category: 'privacy',
        }),
        { headers: { 'user-agent': 'RepublicTest/1' } },
      );
      assert.equal(sent.status, 200, sent.text);
      const mail = app.mailer.lastFeedback();
      assert.equal(mail.replyTo, 'person@example.gov');
      assert.equal(mail.subject.includes('\n'), false);
      assert.equal(mail.subject.includes('\r'), false);
      assert.match(mail.subject, /^ZK-Voting feedback \(Privacy\)$/);
      assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.equal(mail.html.includes('<script'), false);
      assert.match(mail.html, /&amp;/);
      assert.match(mail.html, /&quot;quoted&quot;/);
      assert.equal(mail.text.includes('\r'), false);
      assert.equal(mail.text.includes('\nBcc:'), false);
      assert.match(mail.text, /Name: AdaBcc: evil@evil\.test/);
      assert.match(mail.text, /User-Agent: RepublicTest\/1/);
      assert.match(mail.text, /Terms PDF SHA-256: [0-9a-f]{64}/);
      assert.match(mail.html, /NOT FOR PROFIT/);
      assert.equal(lines.some((line) => line.includes('NEEDLE_do_not_log')), false);
      assert.ok(lines.some((line) => line.includes(`termsPdfSha256=${getTermsDocument().pdfSha256}`)));
    } finally {
      console.info = orig;
      await closeApp(app);
    }
  });

  test('fails closed when the platform super admin has no email', async () => {
    const app = await boot();
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const missing = await api(app, payload(app));
      assert.equal(missing.status, 503);
      assert.equal(missing.json.code, 'FEEDBACK_UNAVAILABLE');
      assert.equal(missing.json.error, 'Feedback cannot be delivered right now. Please try again later.');
      assert.equal(app.mailer.lastFeedback(), null);
      assert.ok(warnings.some((line) => /platform super admin/i.test(line)));
      assert.ok(warnings.every((line) => !line.includes('Please keep the receipt page')));

      await setOperator(app.store, 'operator@example.gov');
      const ok = await api(app, payload(app));
      assert.equal(ok.status, 200, ok.text);
    } finally {
      console.warn = orig;
      await closeApp(app);
    }
  });

  test('dry-run delivery uses the seeded SUPER_ADMIN_EMAIL', async () => {
    const dry = await boot({
      superAdminEmail: 'Operator@Example.Gov',
      sesFromAddress: 'elections@example.gov',
      awsRegion: 'us-east-1',
      sesDryRun: true,
      sesEndpoint: 'http://127.0.0.1:9',
    });
    try {
      const supers = dry.store.listUsers().filter((row) => row.role === 'platform_super_admin');
      assert.equal(supers.length, 1);
      assert.equal(supers[0].contactEmail, 'operator@example.gov');
      const sent = await api(dry, payload(dry, { category: 'suggestion', message: 'Route feedback to the env inbox.' }));
      assert.equal(sent.status, 200, sent.text);
      const mail = dry.mailer.lastFeedback();
      assert.equal(mail.meta.delivery, 'dry-run');
      assert.equal(mail.to, 'operator@example.gov');
      assert.match(mail.text, /Route feedback to the env inbox/);
    } finally {
      await closeApp(dry);
    }
  });

  test('fails closed without SES and captures on the dry-run path', async () => {
    const dry = await boot({
      sesFromAddress: 'elections@example.gov',
      awsRegion: 'us-east-1',
      sesDryRun: true,
      sesEndpoint: 'http://127.0.0.1:9',
    });
    const blocked = await boot({
      sesFromAddress: '',
      awsRegion: '',
      sesDryRun: false,
      captureEmail: false,
      allowCaptureMailer: false,
    });
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await setOperator(blocked.store, 'operator@example.gov');
      const refused = await api(blocked, payload(blocked));
      assert.equal(refused.status, 503);
      assert.equal(refused.json.code, 'FEEDBACK_UNAVAILABLE');
      assert.equal(blocked.mailer.sent.length, 0);
      assert.ok(warnings.some((line) => line.includes('AWS SES is not configured')));

      await setOperator(dry.store, 'operator@example.gov');
      const sent = await api(dry, payload(dry, { category: 'suggestion', message: 'Add a larger skip link.' }));
      assert.equal(sent.status, 200, sent.text);
      const mail = dry.mailer.lastFeedback();
      assert.equal(mail.meta.delivery, 'dry-run');
      assert.equal(mail.to, 'operator@example.gov');
      assert.match(mail.html, /Suggestion/);
      assert.match(mail.text, /Add a larger skip link/);
      assert.match(mail.text, /Terms version: 2/);
    } finally {
      console.warn = orig;
      await closeApp(dry);
      await closeApp(blocked);
    }
  });

  test('rejects an oversized body before it consumes the hourly slot', async () => {
    const app = await boot();
    try {
      await setOperator(app.store, 'operator@example.gov');
      const huge = await api(app, payload(app, { message: 'x'.repeat(20_000) }));
      assert.equal(huge.status, 413);
      assert.equal(huge.json.code, 'PAYLOAD_TOO_LARGE');
      const ok = await api(app, payload(app));
      assert.equal(ok.status, 200, ok.text);
    } finally {
      await closeApp(app);
    }
  });
});

describe('feedback copy', () => {
  test('email template escapes visitor text', () => {
    const rendered = renderFeedbackEmail({
      category: 'general',
      categoryLabel: 'General',
      name: 'A<b>',
      replyTo: null,
      message: '<script>alert(1)</script>',
      acceptance: {
        acceptedAt: '2026-09-29T00:00:00.000Z',
        termsVersion: '2',
        termsPdfSha256: 'ab'.repeat(32),
        termsMarkdownSha256: 'cd'.repeat(32),
      },
      userAgent: 'ua\r\nBcc: evil@evil.test',
      acceptLanguage: 'en',
    });
    assert.equal(rendered.html.includes('<script'), false);
    assert.match(rendered.html, /&lt;script&gt;/);
    assert.match(rendered.html, /A&lt;b&gt;/);
    assert.equal(rendered.text.includes('\r'), false);
    assert.equal(rendered.subject.includes('\n'), false);
  });

  test('all ten locales share the retry sentence placeholder', () => {
    const dicts = catalogs();
    const enKeys = flattenSafe(dicts.en);
    for (const code of SUPPORTED_LOCALES) {
      assert.deepEqual(flattenSafe(dicts[code]), enKeys, code);
      assert.match(dicts[code].feedback.retryIn, /\{minutes\}/);
      assert.match(dicts[code].feedback.retryIn_one, /\{minutes\}/);
    }
    resetLocaleForTests('en');
    assert.equal(
      t('feedback.retryIn', { count: 60, minutes: 60 }),
      'You can send another message in about 60 minutes.',
    );
    assert.equal(
      t('feedback.retryIn', { count: 1, minutes: 1 }),
      'You can send another message in about 1 minute.',
    );
    resetLocaleForTests('en');
  });
});

function flattenSafe(dict, prefix = '') {
  const keys = [];
  for (const [name, value] of Object.entries(dict)) {
    const pathName = prefix ? `${prefix}.${name}` : name;
    if (value && typeof value === 'object') keys.push(...flattenSafe(value, pathName));
    else keys.push(pathName);
  }
  return keys.sort();
}
