// NOT FOR PROFIT — civic public good, not a commercial product.
// Transactional email via AWS SES (SESv2). Tests use an in-memory capture
// mailer so OTP codes are never sent off-box.

import { createHash, randomBytes } from 'node:crypto';

import { HttpError } from './http.mjs';

const OTP_SUBJECT = 'Republic sign-in code';

export function otpEmailBodies({ code, product = 'Republic', purpose } = {}) {
  const pinReset = purpose === 'pin-reset';
  const subject = pinReset ? 'Republic vote PIN reset code' : OTP_SUBJECT;
  const lead = pinReset
    ? `Your ${product} vote PIN reset code is ${code}.`
    : `Your ${product} verification code is ${code}.`;
  const ignore = pinReset
    ? 'It expires in 10 minutes. If you did not ask to reset a vote PIN, ignore this message.'
    : 'It expires in 10 minutes. If you did not try to sign in, ignore this message.';
  const text = [
    lead,
    '',
    ignore,
    '',
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>${pinReset ? `Your ${product} vote PIN reset code is:` : `Your ${product} verification code is:`}</p>
<p style="font-size:1.6rem;font-weight:700;letter-spacing:0.12em">${code}</p>
<p>${ignore}</p>
<p style="color:#444">Civic public good. Not a commercial product.</p>
</body></html>`;
  return { subject, text, html };
}

export function otpFromText(text) {
  const m = String(text || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

/** Outbox row safe to list. Body text stays on the detail route. */
export function publicMailSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    templateId: record.templateId,
    role: record.role,
    to: record.to,
    subject: record.subject,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function headerSafe(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function foldBase64(value) {
  const s = String(value || '');
  const lines = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\r\n');
}

function attachmentMeta(file) {
  const content = Buffer.isBuffer(file.content)
    ? file.content
    : Buffer.from(file.content || '', 'utf8');
  return {
    filename: headerSafe(file.filename || 'attachment'),
    contentType: headerSafe(file.contentType || 'application/octet-stream'),
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  };
}

/**
 * SES Simple content cannot carry attachments. The terms PDF is sent as a
 * raw MIME attachment on the same SES path as OTP mail.
 */
function safeReplyTo(value) {
  const cleaned = headerSafe(value);
  if (!cleaned || /\s/.test(cleaned)) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return '';
  return cleaned;
}

export function buildRawMime({ from, to, subject, text, html, attachments = [], replyTo } = {}) {
  const mixed = `RepublicMixed_${randomBytes(12).toString('hex')}`;
  const alt = `RepublicAlt_${randomBytes(12).toString('hex')}`;
  const reply = safeReplyTo(replyTo);
  const lines = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${headerSafe(subject)}`,
    ...(reply ? [`Reply-To: ${reply}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(text || ''),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(html || ''),
    `--${alt}--`,
  ];
  for (const file of attachments) {
    const att = attachmentMeta(file);
    lines.push(
      `--${mixed}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      foldBase64(att.content.toString('base64')),
    );
  }
  lines.push(`--${mixed}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

async function sendViaSesv2(config, { to, subject, text, html, attachments = [], replyTo }) {
  let SESv2Client;
  let SendEmailCommand;
  try {
    ({ SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2'));
  } catch (err) {
    throw new HttpError(503, `AWS SES SDK is not installed: ${err.message || err}`);
  }
  const client = new SESv2Client({
    region: config.awsRegion,
    ...(config.sesEndpoint ? { endpoint: config.sesEndpoint } : {}),
  });
  const input = {
    FromEmailAddress: config.sesFromAddress,
    Destination: { ToAddresses: [to] },
  };
  if (attachments.length) {
    input.Content = {
      Raw: {
        Data: buildRawMime({
          from: config.sesFromAddress,
          to,
          subject,
          text,
          html,
          attachments,
        }),
      },
    };
  } else {
    input.Content = {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: text, Charset: 'UTF-8' },
          Html: { Data: html, Charset: 'UTF-8' },
        },
      },
    };
  }
  const reply = safeReplyTo(replyTo);
  if (reply) input.ReplyToAddresses = [reply];
  if (config.sesConfigurationSet) {
    input.ConfigurationSetName = config.sesConfigurationSet;
  }
  await client.send(new SendEmailCommand(input));
}

/**
 * @param {Record<string, unknown>} config
 */
export function createMailer(config = {}) {
  const sent = [];
  let sendCount = 0;
  let failureCount = 0;
  const sesReady = Boolean(config.sesFromAddress && config.awsRegion);
  const captureCodes = config.includeOtpInCapture !== false && (config.captureEmail || !sesReady);

  async function send(input = {}) {
    try {
      const record = await deliver(input);
      sendCount += 1;
      return record;
    } catch (err) {
      failureCount += 1;
      throw err;
    }
  }

  async function deliver({ to, subject, text, html, attachments = [], meta = {}, replyTo } = {}) {
    const files = Array.isArray(attachments) ? attachments.map(attachmentMeta) : [];
    const reply = safeReplyTo(replyTo);
    const record = {
      to,
      subject: headerSafe(subject),
      text,
      html,
      replyTo: reply || null,
      attachments: files.map((f) => ({
        filename: f.filename,
        contentType: f.contentType,
        bytes: f.bytes,
        sha256: f.sha256,
        content: f.content,
      })),
      meta: captureCodes ? { ...meta } : { ...meta, code: undefined },
      at: Date.now(),
    };
    sent.push(record);

    if (sesReady && !config.sesDryRun) {
      await sendViaSesv2(config, {
        to,
        subject: record.subject,
        text,
        html,
        attachments: files,
        replyTo: reply || undefined,
      });
      return record;
    }

    if (config.requireEmailMfa && !sesReady && config.allowCaptureMailer === false) {
      throw new HttpError(
        503,
        'email MFA is not configured — set SES_FROM_ADDRESS and AWS_REGION (AWS SES)',
      );
    }
    return record;
  }

  async function sendOtp({ to, code, purpose, factor }) {
    const bodies = otpEmailBodies({ code, product: config.product || 'Republic', purpose });
    return send({
      to,
      ...bodies,
      meta: { purpose, factor, code },
    });
  }

  function lastOtp() {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const code = sent[i]?.meta?.code || otpFromText(sent[i]?.text);
      if (code) return { code, message: sent[i] };
    }
    return null;
  }

  return {
    send,
    sendOtp,
    sent,
    lastOtp,
    lastTermsPdf() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]?.meta?.purpose === 'terms-pdf') return sent[i];
      }
      return null;
    },
    lastTermsUpdated() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]?.meta?.purpose === 'terms-updated') return sent[i];
      }
      return null;
    },
    lastVoteReceipt() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]?.meta?.purpose === 'vote-receipt') return sent[i];
      }
      return null;
    },
    lastOutcomeReport() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]?.meta?.purpose === 'outcome-report') return sent[i];
      }
      return null;
    },
    lastFeedback() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i]?.meta?.purpose === 'feedback') return sent[i];
      }
      return null;
    },
    sesReady,
    vendor: 'ses',
    get sendCount() {
      return sendCount;
    },
    get failureCount() {
      return failureCount;
    },
  };
}
