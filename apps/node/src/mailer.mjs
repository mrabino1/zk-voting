// NOT FOR PROFIT — civic public good, not a commercial product.
// Transactional email via AWS SES (SESv2). Tests use an in-memory capture
// mailer so OTP codes are never sent off-box.

import { HttpError } from './http.mjs';

const OTP_SUBJECT = 'Republic sign-in code';

export function otpEmailBodies({ code, product = 'Republic' }) {
  const text = [
    `Your ${product} verification code is ${code}.`,
    '',
    'It expires in 10 minutes. If you did not try to sign in, ignore this message.',
    '',
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>Your ${product} verification code is:</p>
<p style="font-size:1.6rem;font-weight:700;letter-spacing:0.12em">${code}</p>
<p>It expires in 10 minutes. If you did not try to sign in, ignore this message.</p>
<p style="color:#444">Civic public good. Not a commercial product.</p>
</body></html>`;
  return { subject: OTP_SUBJECT, text, html };
}

export function otpFromText(text) {
  const m = String(text || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

async function sendViaSesv2(config, { to, subject, text, html }) {
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
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: text, Charset: 'UTF-8' },
          Html: { Data: html, Charset: 'UTF-8' },
        },
      },
    },
  };
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
  const sesReady = Boolean(config.sesFromAddress && config.awsRegion);
  const captureCodes = config.includeOtpInCapture !== false && (config.captureEmail || !sesReady);

  async function send({ to, subject, text, html, meta = {} }) {
    const record = {
      to,
      subject,
      text,
      html,
      meta: captureCodes ? { ...meta } : { ...meta, code: undefined },
      at: Date.now(),
    };
    sent.push(record);

    if (sesReady && !config.sesDryRun) {
      await sendViaSesv2(config, { to, subject, text, html });
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
    const bodies = otpEmailBodies({ code, product: config.product || 'Republic' });
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
    sesReady,
    vendor: 'ses',
  };
}
