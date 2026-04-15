/**
 * POST /api/verify-otp
 * Body: { mobile: "9876543210", otp: "123456" }
 *
 * Checks the OTP stored in Upstash Redis. Deletes it on success (one-time use).
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

  const { mobile, otp } = body;

  if (!mobile || !otp || !/^\d{10}$/.test(mobile) || !/^\d{6}$/.test(otp)) {
    return json(400, { valid: false, error: 'Missing or invalid mobile/otp' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.error('Redis init error:', err);
    return json(500, { valid: false, error: 'Service unavailable. Please try again.' });
  }

  /* ── Track wrong attempts to prevent brute force ── */
  const attemptsKey = `verify_attempts:${mobile}`;
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) await redis.expire(attemptsKey, 600);
  if (attempts > 5) {
    return json(429, { valid: false, error: 'Too many incorrect attempts. Request a new OTP.' });
  }

  /* ── Fetch stored OTP ── */
  const stored = await redis.get(`otp:${mobile}`);

  if (!stored) {
    return json(400, { valid: false, error: 'OTP expired. Please request a new one.' });
  }

  if (String(stored) !== String(otp)) {
    return json(400, { valid: false, error: 'Incorrect OTP' });
  }

  /* ── Valid — delete OTP so it can't be reused ── */
  await redis.del(`otp:${mobile}`);
  await redis.del(`verify_attempts:${mobile}`);

  return json(200, { valid: true });
}
