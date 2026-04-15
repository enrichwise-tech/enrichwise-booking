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

// fetch() with an abort-based timeout so a slow upstream can't hang the function
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req) {
  console.log('[send-otp] invoked, method=', req.method);

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
  console.log('[send-otp] parsed body, mobile ends with:', mobile ? mobile.slice(-4) : '(none)');

  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return json(400, { error: 'Please enter a valid 10-digit mobile number' });
  }

  let redis;
  try {
    redis = getRedis();
    console.log('[send-otp] redis client ready');
  } catch (err) {
    console.error('[send-otp] redis init error:', err.message);
    return json(500, { error: 'Service unavailable (init). Please try again.' });
  }

  /* ── Rate limit + redis writes ── */
  let attempts;
  try {
    const rateLimitKey = `ratelimit:${mobile}`;
    console.log('[send-otp] calling redis.incr');
    attempts = await redis.incr(rateLimitKey);
    console.log('[send-otp] incr ok, attempts=', attempts);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
  } catch (err) {
    console.error('[send-otp] redis op error:', err.message);
    return json(500, { error: 'Service unavailable (redis). Please try again.' });
  }

  if (attempts > 3) {
    return json(429, { error: 'Too many attempts. Please try again after 10 minutes.' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));

  try {
    await redis.del(`verify_attempts:${mobile}`);
    await redis.set(`otp:${mobile}`, otp, { ex: 600 });
    console.log('[send-otp] otp stored in redis');
  } catch (err) {
    console.error('[send-otp] redis store error:', err.message);
    return json(500, { error: 'Service unavailable (store). Please try again.' });
  }

  /* ── Send via WATI ── */
  const watiBase = (process.env.WATI_API_URL || '').replace(/\/$/, '');
  const templateName = process.env.WATI_TEMPLATE_NAME;
  const watiToken = process.env.WATI_API_TOKEN;

  if (!watiBase || !templateName || !watiToken) {
    console.error('[send-otp] WATI env vars missing', {
      hasUrl: !!watiBase, hasTemplate: !!templateName, hasToken: !!watiToken
    });
    return json(500, { error: 'WATI not configured' });
  }

  const watiEndpoint = `${watiBase}/api/v1/sendTemplateMessage?whatsappNumber=91${mobile}`;
  const watiPayload = {
    template_name: templateName,
    broadcast_name: `otp_${mobile}_${Date.now()}`,
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
    console.log('[send-otp] WATI response status=', watiRes.status, 'body=', respText.slice(0, 300));

    if (!watiRes.ok) {
      return json(502, { error: 'Could not send OTP (WATI ' + watiRes.status + '). Please try again.' });
    }
  } catch (err) {
    console.error('[send-otp] WATI fetch error:', err.name, err.message);
    const msg = err.name === 'AbortError' ? 'WATI timed out' : 'WATI unreachable';
    return json(502, { error: msg });
  }

  console.log('[send-otp] success');
  return json(200, { success: true, message: 'OTP sent via WhatsApp' });
}
