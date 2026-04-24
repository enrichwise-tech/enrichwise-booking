/**
 * POST /api/send-otp-email
 * Body: { mobile: "9876543210", country_code: "91", email: "user@example.com" }
 *
 * Email-OTP fallback for users without WhatsApp. Generates a 6-digit OTP,
 * stores it under the SAME `otp:<fullNumber>` key as send-otp.js, then
 * delivers via ZeptoMail. Verification flows through /api/verify-otp
 * unchanged — the storage key is medium-agnostic.
 *
 * Rate limit shares the WhatsApp-OTP key (`ratelimit:<mobile>`), so a user
 * can't bypass throttling by switching delivery medium.
 */
import { getRedis } from './_redis.js';
import { sendAlert } from './_alert.js';
import { sendOtpEmail } from './_zepto.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  console.log('[send-otp-email] invoked, method=', req.method);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { mobile, email } = body;
  const countryCode = String(body.country_code || '91').replace(/\D/g, '') || '91';

  if (!mobile || !/^\d{6,15}$/.test(String(mobile))) {
    return res.status(400).json({ error: 'Please enter a valid mobile number' });
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (!/^\d{1,4}$/.test(countryCode)) {
    return res.status(400).json({ error: 'Invalid country code' });
  }

  const fullNumber = `${countryCode}${mobile}`;

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.error('[send-otp-email] redis init error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (init). Please try again.' });
  }

  /* ── Shared rate limit with WhatsApp OTP ── */
  let attempts;
  try {
    const rateLimitKey = `ratelimit:${mobile}`;
    attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
  } catch (err) {
    console.error('[send-otp-email] redis op error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (redis). Please try again.' });
  }

  if (attempts > 3) {
    return res.status(429).json({ error: 'Too many attempts. Please try again after 10 minutes.' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));

  try {
    await redis.del(`verify_attempts:${fullNumber}`);
    await redis.set(`otp:${fullNumber}`, otp, { ex: 600 });
  } catch (err) {
    console.error('[send-otp-email] redis store error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (store). Please try again.' });
  }

  try {
    await sendOtpEmail({ to: email, otp });
    console.log('[send-otp-email] success, domain=', email.split('@').pop());
    return res.status(200).json({ success: true, message: 'OTP sent via email' });
  } catch (err) {
    console.error('[send-otp-email] zepto error:', err.message);
    sendAlert('OTP email send failed', {
      mobile: `+${fullNumber}`,
      email,
      error: err.message
    }).catch(() => {});
    return res.status(502).json({ error: 'Could not send OTP via email. Please try WhatsApp instead.' });
  }
}
