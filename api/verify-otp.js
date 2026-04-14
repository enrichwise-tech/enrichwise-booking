/**
 * POST /api/verify-otp
 * Body: { mobile: "9876543210", otp: "123456" }
 *
 * Checks the OTP stored in Vercel KV. Deletes it on success (one-time use).
 */

import { kv } from '@vercel/kv';

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS });
  }

  const { mobile, otp } = body;

  if (!mobile || !otp || !/^\d{10}$/.test(mobile) || !/^\d{6}$/.test(otp)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid mobile/otp' }), { status: 400, headers: CORS });
  }

  /* ── Track wrong attempts to prevent brute force ── */
  const attemptsKey = `verify_attempts:${mobile}`;
  const attempts = await kv.incr(attemptsKey);
  if (attempts === 1) await kv.expire(attemptsKey, 600);
  if (attempts > 5) {
    return new Response(
      JSON.stringify({ valid: false, error: 'Too many incorrect attempts. Request a new OTP.' }),
      { status: 429, headers: CORS }
    );
  }

  /* ── Fetch stored OTP ── */
  const stored = await kv.get(`otp:${mobile}`);

  if (!stored) {
    return new Response(
      JSON.stringify({ valid: false, error: 'OTP expired. Please request a new one.' }),
      { status: 400, headers: CORS }
    );
  }

  if (String(stored) !== String(otp)) {
    return new Response(
      JSON.stringify({ valid: false, error: 'Incorrect OTP' }),
      { status: 400, headers: CORS }
    );
  }

  /* ── Valid — delete OTP so it can't be reused ── */
  await kv.del(`otp:${mobile}`);
  await kv.del(`verify_attempts:${mobile}`);

  return new Response(
    JSON.stringify({ valid: true }),
    { status: 200, headers: CORS }
  );
}
