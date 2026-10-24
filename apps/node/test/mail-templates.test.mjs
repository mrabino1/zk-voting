// NOT FOR PROFIT — civic public good, not a commercial product.
// Role-promotion mail templates, outbox, and grant wiring.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DEMO_JURISDICTION_ID } from '../src/recordIds.mjs';
import { createApp } from '../src/server.mjs';
import {
  PROMOTION_ROLES,
  escapeHtml,
  listPromotionTemplates,
  renderPromotionEmail,
  templateIdForRole,
} from '../src/mailTemplates.mjs';

let tmp;
let server;
let base;
let webhook;
let webhookUrl;
let webhookPosts;
const superJar = {};
const adminJar = {};
const officerJar = {};
const voterJar = {};

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) applyCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json, text, status: res.status };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

describe('role-promotion mail templates', () => {
  test('every promotion role has HTML + text with the civic notice', () => {
    const listed = listPromotionTemplates();
    assert.equal(listed.length, PROMOTION_ROLES.length);
    for (const role of PROMOTION_ROLES) {
      const rendered = renderPromotionEmail(role, { sample: true, handle: 'officer<script>' });
      assert.ok(rendered, role);
      assert.equal(rendered.templateId, templateIdForRole(role));
      assert.match(rendered.subject, /ZK-Voting/);
      assert.match(rendered.text, /NOT FOR PROFIT/);
      assert.match(rendered.text, /not a vote receipt/i);
      assert.match(rendered.text, /civic L2/i);
      assert.match(rendered.html, /NOT FOR PROFIT/);
      assert.match(rendered.html, /not a vote receipt/i);
      assert.doesNotMatch(rendered.html, /<script>/);
      assert.match(rendered.html, new RegExp(escapeHtml('officer<script>')));
      assert.match(rendered.html, /href="http:\/\/localhost:3000\/(admin|back-office)"/);
    }
  });

  test('platform admin preview does not invent a jurisdiction unless sampled', () => {
    const live = renderPromotionEmail('platform_admin', { handle: 'pat' });
    assert.doesNotMatch(live.text, /Demo jurisdiction/);
    const sample = renderPromotionEmail('platform_admin', { sample: true });
    assert.match(sample.text, /Demo jurisdiction/);
  });
});

describe('role-promotion mail API', () => {
  before(async () => {
    webhookPosts = [];
    webhook = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        webhookPosts.push({ url: req.url, json });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    webhookUrl = `http://127.0.0.1:${webhook.address().port}/mail`;

    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-mail-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'super',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      mailWebhookUrl: webhookUrl,
      publicBaseUrl: 'http://127.0.0.1:3000',
    });
    server = await listen(created.app);
    base = `http://127.0.0.1:${server.address().port}`;

    const superLogin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'super' },
      jar: superJar,
    });
    assert.equal(superLogin.status, 200);
    const adminLogin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'host-admin', role: 'voter' },
      jar: adminJar,
    });
    assert.equal(adminLogin.status, 200);
    const officerLogin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'north-clerk', role: 'voter' },
      jar: officerJar,
    });
    assert.equal(officerLogin.status, 200);
    const voterLogin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter-mail', role: 'voter' },
      jar: voterJar,
    });
    assert.equal(voterLogin.status, 200);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => webhook.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  test('bootstrap super admin does not enqueue promotion mail', async () => {
    const { status, json } = await api('GET', '/api/mail/outbox', { jar: superJar });
    assert.equal(status, 200, json?.error);
    assert.equal(json.outbox.length, 0);
  });

  test('GET /api/config advertises mail outbox policy', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.mail.webhookConfigured, true);
    assert.match(json.mail.note, /civic L2/);
  });

  test('unauthenticated template list is 401', async () => {
    const { status } = await api('GET', '/api/mail/templates');
    assert.equal(status, 401);
  });

  test('voter cannot preview templates', async () => {
    const { status } = await api('GET', '/api/mail/templates', { jar: voterJar });
    assert.equal(status, 403);
  });

  test('operators can preview every promotion template', async () => {
    const list = await api('GET', '/api/mail/templates', { jar: superJar });
    assert.equal(list.status, 200);
    assert.equal(list.json.templates.length, PROMOTION_ROLES.length);
    for (const row of list.json.templates) {
      const preview = await api(
        'GET',
        `/api/mail/templates/${encodeURIComponent(row.id)}?handle=preview-user`,
        { jar: superJar },
      );
      assert.equal(preview.status, 200, row.id);
      assert.equal(preview.json.template.role, row.role);
      assert.match(preview.json.template.html, /preview-user/);
      assert.match(preview.json.template.html, /NOT FOR PROFIT/);
    }
  });

  test('person can save a contact email', async () => {
    const bad = await api('PATCH', '/api/me/contact-email', {
      jar: officerJar,
      body: { contactEmail: 'not-an-email' },
    });
    assert.equal(bad.status, 400);
    const saved = await api('PATCH', '/api/me/contact-email', {
      jar: officerJar,
      body: { contactEmail: 'North.Clerk@Example.Gov' },
    });
    assert.equal(saved.status, 200, saved.json?.error);
    assert.equal(saved.json.contactEmail, 'north.clerk@example.gov');
    const me = await api('GET', '/api/me', { jar: officerJar });
    assert.equal(me.json.me.contactEmail, 'north.clerk@example.gov');
    assert.equal(me.json.user.hasContactEmail, true);
    assert.equal(me.json.user.contactEmail, undefined);
  });

  test('granting clerk queues the clerk template, notifies, and posts the webhook', async () => {
    webhookPosts.length = 0;
    const granted = await api('POST', `/api/jurisdictions/${DEMO_JURISDICTION_ID}/roles`, {
      jar: superJar,
      body: { handle: 'north-clerk', role: 'clerk' },
    });
    assert.equal(granted.status, 200, granted.json?.error);
    assert.equal(granted.json.created, true);
    assert.equal(granted.json.mail.skipped, false);
    assert.equal(granted.json.mail.mail.templateId, 'role_promoted.clerk');
    assert.equal(granted.json.mail.mail.status, 'sent');
    assert.equal(granted.json.mail.mail.to, 'north.clerk@example.gov');

    const notes = await api('GET', '/api/notifications', { jar: officerJar });
    assert.equal(notes.status, 200);
    const promo = notes.json.notifications.find((n) => n.type === 'role_promoted');
    assert.ok(promo);
    assert.match(promo.title, /clerk/i);

    assert.equal(webhookPosts.length, 1);
    assert.equal(webhookPosts[0].json.nfp, true);
    assert.equal(webhookPosts[0].json.templateId, 'role_promoted.clerk');
    assert.equal(webhookPosts[0].json.to, 'north.clerk@example.gov');
    assert.match(webhookPosts[0].json.text, /Demo jurisdiction/);
    assert.match(webhookPosts[0].json.html, /NOT FOR PROFIT/);
  });

  test('re-granting the same clerk does not send a second mail', async () => {
    webhookPosts.length = 0;
    const granted = await api('POST', `/api/jurisdictions/${DEMO_JURISDICTION_ID}/roles`, {
      jar: superJar,
      body: { handle: 'north-clerk', role: 'clerk' },
    });
    assert.equal(granted.status, 200, granted.json?.error);
    assert.equal(granted.json.created, false);
    assert.equal(granted.json.mail.skipped, true);
    assert.equal(granted.json.mail.reason, 'already_granted');
    assert.equal(webhookPosts.length, 0);

    const outbox = await api('GET', '/api/mail/outbox', { jar: superJar });
    const clerkMails = outbox.json.outbox.filter((row) => row.role === 'clerk');
    assert.equal(clerkMails.length, 1);
  });

  test('approving a platform admin uses the admin template', async () => {
    const approved = await api('POST', '/api/admin/admins', {
      jar: superJar,
      body: { handle: 'host-admin', contactEmail: 'host.admin@example.gov' },
    });
    assert.equal(approved.status, 201, approved.json?.error);
    assert.equal(approved.json.user.role, 'platform_admin');
    assert.equal(approved.json.mail.mail.templateId, 'role_promoted.platform_admin');
    assert.equal(approved.json.mail.mail.status, 'sent');
    assert.doesNotMatch(approved.json.mail.mail.subject, /Demo jurisdiction/);

    const full = await api('GET', `/api/mail/outbox/${approved.json.mail.mail.id}`, {
      jar: superJar,
    });
    assert.equal(full.status, 200);
    assert.match(full.json.mail.html, /platform admin/i);
    assert.doesNotMatch(full.json.mail.text, /Demo jurisdiction/);
  });

  test('re-approving the same platform admin does not mail again', async () => {
    const before = await api('GET', '/api/mail/outbox', { jar: superJar });
    const count = before.json.outbox.filter((row) => row.role === 'platform_admin').length;
    const again = await api('POST', '/api/admin/admins', {
      jar: superJar,
      body: { handle: 'host-admin' },
    });
    assert.equal(again.status, 201, again.json?.error);
    assert.equal(again.json.mail.skipped, true);
    const after = await api('GET', '/api/mail/outbox', { jar: superJar });
    assert.equal(
      after.json.outbox.filter((row) => row.role === 'platform_admin').length,
      count,
    );
  });

  test('election staff grant uses the staff template', async () => {
    const created = await api('POST', '/api/elections', {
      jar: superJar,
      body: {
        title: 'Mail staff contest',
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const staffUser = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'poll-staff', role: 'voter' },
      jar: {},
    });
    assert.equal(staffUser.status, 200);
    const granted = await api('POST', `/api/elections/${created.json.election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff', contactEmail: 'poll.staff@example.gov' },
    });
    assert.equal(granted.status, 201, granted.json?.error);
    assert.equal(granted.json.mail.mail.templateId, 'role_promoted.election_staff');
    assert.equal(granted.json.mail.mail.status, 'sent');
    const full = await api('GET', `/api/mail/outbox/${granted.json.mail.mail.id}`, {
      jar: superJar,
    });
    assert.match(full.json.mail.text, /Mail staff contest/);
  });

  test('PATCH user to voter does not send a promotion mail', async () => {
    const before = await api('GET', '/api/mail/outbox', { jar: superJar });
    const count = before.json.outbox.length;
    const demote = await api('PATCH', `/api/users/${(await api('GET', '/api/me', { jar: voterJar })).json.user.id}`, {
      jar: superJar,
      body: { role: 'voter' },
    });
    assert.equal(demote.status, 200, demote.json?.error);
    assert.equal(demote.json.mail.skipped, true);
    const after = await api('GET', '/api/mail/outbox', { jar: superJar });
    assert.equal(after.json.outbox.length, count);
  });

  test('staff grant for an unknown handle skips mail (no person yet)', async () => {
    const elections = await api('GET', '/api/elections', { jar: superJar });
    const electionId = elections.json.elections[0].id;
    const granted = await api('POST', `/api/elections/${electionId}/staff`, {
      jar: superJar,
      body: { handle: 'not-a-person-yet' },
    });
    assert.equal(granted.status, 201, granted.json?.error);
    assert.equal(granted.json.user, null);
    assert.equal(granted.json.mail.skipped, true);
    assert.equal(granted.json.mail.reason, 'no_user');
  });

  test('admin SPA includes the promotion-mail panel', async () => {
    const page = await api('GET', '/admin', { jar: superJar });
    assert.equal(page.status, 200);
    assert.match(page.text, /Role-promotion emails/);
    assert.match(page.text, /mail-template/);
  });
});
