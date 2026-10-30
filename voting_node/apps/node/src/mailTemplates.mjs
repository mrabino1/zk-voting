// NOT FOR PROFIT — civic public good, not a commercial product.
// Role-promotion mail is a Node operator notice. It is never a vote receipt
// and must never be written onto civic L2 transactions.

import { brandName } from './branding.mjs';
import { ROLE_LABELS } from './roles.mjs';

export const PROMOTION_ROLES = Object.freeze([
  'platform_super_admin',
  'platform_admin',
  'election_staff',
  'clerk',
  'registrar',
  'disqualification_officer',
  'tally_operator',
]);

export function isPromotionRole(role) {
  return PROMOTION_ROLES.includes(String(role || ''));
}

export function templateIdForRole(role) {
  return `role_promoted.${role}`;
}

export function roleFromTemplateId(id) {
  const raw = String(id || '');
  const prefix = 'role_promoted.';
  if (!raw.startsWith(prefix)) return '';
  return raw.slice(prefix.length);
}

const COPY = Object.freeze({
  platform_super_admin: {
    headline: 'You were promoted to platform super admin',
    duties: [
      'You approve platform admins on this Node.',
      'You wire the host, the election factory, and the other modules a jurisdiction needs to run.',
      'Treat this office as a public trust. There is no token, no paid tier, and no fee taken from voters.',
    ],
    ctaPath: '/admin',
    ctaLabel: 'Open platform admin',
  },
  platform_admin: {
    headline: 'You were promoted to platform admin',
    duties: [
      'You approve election staff for each contest.',
      'You create jurisdictions and grant clerks, registrars, disqualification officers, tally operators, and election staff.',
      'Super admin remains the only office that can approve or revoke a platform admin.',
    ],
    ctaPath: '/admin',
    ctaLabel: 'Open platform admin',
  },
  election_staff: {
    headline: 'You were approved as election staff',
    duties: [
      'You register unbounded external eligibility parties for an election — felony, death, age, and any other system that must still be able to reject a ballot after registration.',
      'A party may veto or must-attest a person at cast time. That live gate is independent of the frozen clerk roll.',
      'Identity commitments are checked, then discarded. They are never stored on the ballot or the vote receipt.',
    ],
    ctaPath: '/back-office',
    ctaLabel: 'Open the back office',
  },
  clerk: {
    headline: 'You were granted election clerk',
    duties: [
      'You create elections for this jurisdiction and freeze the roll when it is ready.',
      'Public vote proofs publish after the hour closes and the disclosure delay elapses, from the first ballot. This console does not show a live jurisdiction tick.',
    ],
    ctaPath: '/back-office',
    ctaLabel: 'Open the back office',
  },
  registrar: {
    headline: 'You were granted registrar',
    duties: [
      'You insert identity commitments onto the roll for this jurisdiction.',
      'The Merkle leaf is the commitment, not a passkey user id and not an Ethereum address.',
    ],
    ctaPath: '/back-office',
    ctaLabel: 'Open the back office',
  },
  disqualification_officer: {
    headline: 'You were granted disqualification officer',
    duties: [
      'You apply the public reason catalog. Every mark has a reason code, an evidence hash, an issuer, and a time.',
      'There are no silent deletes. Revocation is an event.',
    ],
    ctaPath: '/back-office',
    ctaLabel: 'Open the back office',
  },
  tally_operator: {
    headline: 'You were granted tally operator',
    duties: [
      'You post counts after cutoff. On opens-ballots elections you open the demo envelopes under the published ceremony.',
      'This message is not a vote receipt. Choice is never shown here.',
    ],
    ctaPath: '/back-office',
    ctaLabel: 'Open the back office',
  },
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function samplePromotionVars(role, extras = {}) {
  const copy = COPY[role] || COPY.platform_admin;
  const baseUrl = String(extras.publicBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const sample = extras.sample === true;
  return {
    handle: extras.handle || (sample ? 'officer' : ''),
    role,
    roleLabel: ROLE_LABELS[role] || role,
    jurisdictionId: extras.jurisdictionId || (sample ? 'demo' : ''),
    jurisdictionName: extras.jurisdictionName || (sample ? 'Demo jurisdiction' : ''),
    electionId: extras.electionId || (sample ? 'preview' : ''),
    electionTitle: extras.electionTitle || (sample ? 'County general' : ''),
    grantedByHandle: extras.grantedByHandle || (sample ? 'admin' : ''),
    publicBaseUrl: baseUrl,
    officeUrl: extras.officeUrl || `${baseUrl}${copy.ctaPath}`,
    product: brandName(),
    year: String(extras.year || new Date().getUTCFullYear()),
  };
}

function scopeLines(vars) {
  const lines = [];
  if (vars.jurisdictionName || vars.jurisdictionId) {
    lines.push(
      `Jurisdiction: ${vars.jurisdictionName || vars.jurisdictionId}${
        vars.jurisdictionId && vars.jurisdictionName ? ` (${vars.jurisdictionId})` : ''
      }.`,
    );
  }
  if (vars.electionTitle || vars.electionId) {
    lines.push(
      `Election: ${vars.electionTitle || vars.electionId}${
        vars.electionId && vars.electionTitle ? ` (${vars.electionId})` : ''
      }.`,
    );
  }
  if (vars.grantedByHandle) {
    lines.push(`Granted by: ${vars.grantedByHandle}.`);
  }
  return lines;
}

function buildText({ copy, vars }) {
  const parts = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    `Hello ${vars.handle},`,
    '',
    copy.headline + '.',
    ...copy.duties,
    ...scopeLines(vars),
    '',
    `${copy.ctaLabel}: ${vars.officeUrl}`,
    '',
    'This message is about your operator role. It is not a vote receipt. Ballot choice is never included.',
    'Promotion mail is stored on the Node. It is never written to civic L2 transactions.',
    '',
    `— ${vars.product}`,
  ];
  return parts.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
}

function buildHtml({ copy, vars }) {
  const duties = copy.duties.map((d) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:#111111;">${escapeHtml(d)}</p>`).join('');
  const scope = scopeLines(vars)
    .map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:14px;line-height:1.45;color:#333333;">${escapeHtml(line)}</p>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(copy.headline)} · ${escapeHtml(brandName())}</title>
</head>
<body style="margin:0;padding:0;background:#e8e4d9;color:#111111;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px 12px 40px;">
    <p style="margin:0 0 12px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#13294b;">NOT FOR PROFIT</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid:#c9c3b2;border-radius:4px;">
      <tr>
        <td style="background:#13294b;color:#f4f1ea;padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.04em;">${escapeHtml(brandName())}</p>
          <h1 style="margin:0;font-size:22px;line-height:1.3;">${escapeHtml(copy.headline)}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Hello ${escapeHtml(vars.handle)},</p>
          ${duties}
          ${scope}
          <p style="margin:20px 0 0;">
            <a href="${escapeHtml(vars.officeUrl)}" style="display:inline-block;background:#13294b;color:#f4f1ea;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:4px;">${escapeHtml(copy.ctaLabel)}</a>
          </p>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.45;color:#444444;">This message is about your operator role. It is not a vote receipt. Ballot choice is never included. Promotion mail is stored on the Node and is never written to civic L2 transactions.</p>
        </td>
      </tr>
    </table>
    <p style="margin:16px 4px 0;font-size:12px;line-height:1.45;color:#444444;">Civic public good. Not a commercial product. No token. No fees to voters.</p>
  </div>
</body>
</html>`;
}

function notificationCopy(role, vars) {
  const label = ROLE_LABELS[role] || role;
  const scope = vars.electionTitle
    ? ` on ${vars.electionTitle}`
    : vars.jurisdictionName
      ? ` on ${vars.jurisdictionName}`
      : '';
  return {
    title: `Promoted to ${label}`,
    body: `${copyHeadline(role)}${scope}. This is not a vote receipt.`,
  };
}

function copyHeadline(role) {
  return COPY[role]?.headline || `You were promoted to ${ROLE_LABELS[role] || role}`;
}

export function describeTemplate(role) {
  const copy = COPY[role];
  if (!copy) return null;
  return {
    id: templateIdForRole(role),
    role,
    label: ROLE_LABELS[role] || role,
    headline: copy.headline,
    ctaPath: copy.ctaPath,
    ctaLabel: copy.ctaLabel,
    subject: `${copy.headline} · ${brandName()}`,
  };
}

export function listPromotionTemplates() {
  return PROMOTION_ROLES.map((role) => describeTemplate(role)).filter(Boolean);
}

export function renderPromotionEmail(role, varsInput = {}) {
  if (!isPromotionRole(role)) {
    return null;
  }
  const copy = COPY[role];
  const vars = samplePromotionVars(role, varsInput);
  const notice = notificationCopy(role, vars);
  return {
    templateId: templateIdForRole(role),
    role,
    label: ROLE_LABELS[role] || role,
    subject: `${copy.headline} · ${brandName()}`,
    text: buildText({ copy, vars }),
    html: buildHtml({ copy, vars }),
    notificationTitle: notice.title,
    notificationBody: notice.body,
    vars,
  };
}

export function renderPromotionTemplate(templateId, varsInput = {}) {
  const role = roleFromTemplateId(templateId) || (isPromotionRole(templateId) ? templateId : '');
  return renderPromotionEmail(role, varsInput);
}
