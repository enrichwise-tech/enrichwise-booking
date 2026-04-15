/**
 * POST /api/send-otp
 * Body: { mobile: "9876543210" }
 *
 * Generates a 6-digit OTP, stores it in Upstash Redis with a 10-min TTL,
 * then sends it via WATI WhatsApp template message.
 */
import { getRedis } from './_redis.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { mobile } = body;

  /* ── Validate mobile ── */
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return json(400, { error: 'Please enter a valid 10-digit mobile number' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.error('Redis init error:', err);
    return json(500, { error: 'Service unavailable. Please try again.' });
  }

  /* ── Rate limit: max 3 OTPs per mobile per 10 minutes ── */
  const rateLimitKey = `ratelimit:${mobile}`;
  const attempts = await redis.incr(rateLimitKey);
  if (attempts === 1) await redis.expire(rateLimitKey, 600);
  if (attempts > 3) {
    return json(429, { error: 'Too many attempts. Please try again after 10 minutes.' });
  }

  /* ── Generate 6-digit OTP ── */
  const otp = String(Math.floor(100000 + Math.random() * 900000));

  /* ── Reset wrong-attempt counter from any previous OTP ── */
  await redis.del(`verify_attempts:${mobile}`);

  /* ── Store OTP with 10-minute TTL ── */
  await redis.set(`otp:${mobile}`, otp, { ex: 600 });

  /* ── Send via WATI ── */
  const watiBase = (process.env.WATI_API_URL || '').replace(/\/$/, '');
  const watiEndpoint = `${watiBase}/api/v1/sendTemplateMessage?whatsappNumber=91${mobile}`;

  const watiPayload = {
    template_name: process.env.WATI_TEMPLATE_NAME,
    broadcast_name: `otp_${mobile}_${Date.now()}`,
    parameters: [
      { name: '1', value: otp },
      { name: '2', value: '10 minutes' }
    ]
  };

  try {
    const watiRes = await fetch(watiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WATI_API_TOKEN}`
      },
      body: JSON.stringify(watiPayload)
    });

    if (!watiRes.ok) {
      const errText = await watiRes.text();
      console.error('WATI error:', watiRes.status, errText);
      return json(502, { error: 'Could not send OTP. Please try again.' });
    }
  } catch (err) {
    console.error('WATI fetch error:', err);
    return json(502, { error: 'Could not send OTP. Please try again.' });
  }

  return json(200, { success: true, message: 'OTP sent via WhatsApp' });
}
