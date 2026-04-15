/**
 * POST /api/send-otp
 * Body: { mobile: "9876543210" }
 *
 * Generates a 6-digit OTP, stores it in Upstash Redis with a 10-min TTL,
 * then sends it via WATI WhatsApp template message.
 */
import { getRedis } from './_redis.js';
import { sendAlert } from './_alert.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req, res) {
  setCors(res);
  console.log('[send-otp] invoked, method=', req.method);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Vercel Node runtime auto-parses JSON bodies when Content-Type is application/json
  const body = req.body || {};
  const { mobile } = body;
  const countryCode = String(body.country_code || '91').replace(/\D/g, '') || '91';
  console.log('[send-otp] parsed body, cc=+' + countryCode + ', mobile ends with:', mobile ? String(mobile).slice(-4) : '(none)');

  if (!mobile || !/^\d{6,15}$/.test(String(mobile))) {
    return res.status(400).json({ error: 'Please enter a valid mobile number' });
  }
  if (!/^\d{1,4}$/.test(countryCode)) {
    return res.status(400).json({ error: 'Invalid country code' });
  }
  const fullNumber = `${countryCode}${mobile}`;

  let redis;
  try {
    redis = getRedis();
    console.log('[send-otp] redis client ready');
  } catch (err) {
    console.error('[send-otp] redis init error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (init). Please try again.' });
  }

  /* ── Rate limit ── */
  let attempts;
  try {
    const rateLimitKey = `ratelimit:${mobile}`;
    attempts = await redis.incr(rateLimitKey);
    console.log('[send-otp] incr ok, attempts=', attempts);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
  } catch (err) {
    console.error('[send-otp] redis op error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (redis). Please try again.' });
  }

  if (attempts > 3) {
    return res.status(429).json({ error: 'Too many attempts. Please try again after 10 minutes.' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));

  try {
    await redis.del(`verify_attempts:${fullNumber}`);
    await redis.set(`otp:${fullNumber}`, otp, { ex: 600 });
    console.log('[send-otp] otp stored in redis');
  } catch (err) {
    console.error('[send-otp] redis store error:', err.message);
    return res.status(500).json({ error: 'Service unavailable (store). Please try again.' });
  }

  /* ── Send via WATI ── */
  const watiBase = (process.env.WATI_API_URL || '').replace(/\/$/, '');
  const templateName = process.env.WATI_TEMPLATE_NAME;
  // Strip any accidental "Bearer " prefix so we don't double it
  const watiToken = (process.env.WATI_API_TOKEN || '').replace(/^Bearer\s+/i, '').trim();

  if (!watiBase || !templateName || !watiToken) {
    console.error('[send-otp] WATI env vars missing', {
      hasUrl: !!watiBase, hasTemplate: !!templateName, hasToken: !!watiToken
    });
    return res.status(500).json({ error: 'WATI not configured' });
  }

  const watiEndpoint = `${watiBase}/api/v1/sendTemplateMessage?whatsappNumber=${fullNumber}`;
  const watiPayload = {
    template_name: templateName,
    broadcast_name: `otp_${fullNumber}_${Date.now()}`,
    parameters: [
      { name: '1', value: otp },
      { name: '2', value: '10 minutes' }
    ]
  };

  console.log('[send-otp] calling WATI at', watiEndpoint);

  try {
    const watiRes = await fetchWithTimeout(watiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${watiToken}`
      },
      body: JSON.stringify(watiPayload)
    }, 10000);

    const respText = await watiRes.text();
    console.log('[send-otp] WATI status=', watiRes.status, 'body=', respText.slice(0, 300));

    if (!watiRes.ok) {
      sendAlert('OTP send failed', {
        mobile: `+${fullNumber}`,
        wati_status: watiRes.status
      }).catch(() => {});
      return res.status(502).json({ error: 'Could not send OTP (WATI ' + watiRes.status + '). Please try again.' });
    }
  } catch (err) {
    console.error('[send-otp] WATI fetch error:', err.name, err.message);
    const msg = err.name === 'AbortError' ? 'WATI timed out' : 'WATI unreachable';
    sendAlert('OTP send crashed', {
      mobile: `+${fullNumber}`,
      error: `${err.name}: ${err.message}`
    }).catch(() => {});
    return res.status(502).json({ error: msg });
  }

  console.log('[send-otp] success');
  return res.status(200).json({ success: true, message: 'OTP sent via WhatsApp' });
}
