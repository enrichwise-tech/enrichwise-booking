/**
 * Minimal ZeptoMail (Zoho transactional email) client.
 *
 * Env vars:
 *   ZEPTO_API_TOKEN     — Send Mail Token from ZeptoMail Agent → SMTP/API tab.
 *                         Code auto-prepends "Zoho-enczapikey " if missing.
 *   ZEPTO_FROM_ADDRESS  — (optional) defaults to noreply@mail.enrichwise.com
 *   ZEPTO_FROM_NAME     — (optional) defaults to "Enrichwise"
 *
 * Domain mail.enrichwise.com is verified in ZeptoMail (DKIM + bounce CNAME)
 * as of 2026-04-24.
 */
const ZEPTO_API_URL = 'https://api.zeptomail.in/v1.1/email';

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function sendOtpEmail({ to, otp }) {
  const rawToken = (process.env.ZEPTO_API_TOKEN || '').trim();
  if (!rawToken) throw new Error('ZEPTO_API_TOKEN not set');

  const auth = /^Zoho-enczapikey\s/i.test(rawToken) ? rawToken : `Zoho-enczapikey ${rawToken}`;
  const fromAddress = (process.env.ZEPTO_FROM_ADDRESS || 'noreply@mail.enrichwise.com').trim();
  const fromName    = (process.env.ZEPTO_FROM_NAME    || 'Enrichwise').trim();

  const payload = {
    from: { address: fromAddress, name: fromName },
    to: [{ email_address: { address: to } }],
    subject: `Your Enrichwise verification code: ${otp}`,
    htmlbody: `
      <div style="font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="font-size: 22px; font-weight: 600; color: #1f7a4d;">Enrichwise</div>
        </div>
        <p style="font-size: 16px; line-height: 1.5; margin: 0 0 8px;">Your verification code is</p>
        <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; padding: 18px 0; text-align: center; background: #f4f9f6; border-radius: 8px; margin: 12px 0 16px; color: #1f7a4d;">${otp}</div>
        <p style="font-size: 14px; color: #555; margin: 0 0 6px;">This code is valid for <strong>10 minutes</strong>. Please don't share it with anyone.</p>
        <p style="font-size: 12px; color: #999; margin-top: 32px;">If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `,
    textbody: `Your Enrichwise verification code is ${otp}. Valid for 10 minutes. If you didn't request this, ignore this email.`
  };

  const res = await fetchWithTimeout(ZEPTO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': auth
    },
    body: JSON.stringify(payload)
  }, 10000);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zepto ${res.status}: ${text.slice(0, 300)}`);
  }
  return { ok: true };
}
