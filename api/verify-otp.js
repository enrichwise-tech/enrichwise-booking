/**
 * POST /api/verify-otp
 * Body: { mobile: "9876543210", otp: "123456" }
 *
 * Checks the OTP stored in Upstash Redis. Deletes it on success (one-time use).
 */
import { getRedis } from './_redis.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { mobile, otp } = body;

  if (!mobile || !otp || !/^\d{10}$/.test(mobile) || !/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({ valid: false, error: 'Missing or invalid mobile/otp' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.error('[verify-otp] redis init error:', err.message);
    return res.status(500).json({ valid: false, error: 'Service unavailable. Please try again.' });
  }

  /* ── Track wrong attempts to prevent brute force ── */
  let attempts;
  try {
    const attemptsKey = `verify_attempts:${mobile}`;
    attempts = await redis.incr(attemptsKey);
    if (attempts === 1) await redis.expire(attemptsKey, 600);
  } catch (err) {
    console.error('[verify-otp] redis op error:', err.message);
    return res.status(500).json({ valid: false, error: 'Service unavailable. Please try again.' });
  }

  if (attempts > 5) {
    return res.status(429).json({ valid: false, error: 'Too many incorrect attempts. Request a new OTP.' });
  }

  /* ── Fetch stored OTP ── */
  let stored;
  try {
    stored = await redis.get(`otp:${mobile}`);
  } catch (err) {
    console.error('[verify-otp] redis get error:', err.message);
    return res.status(500).json({ valid: false, error: 'Service unavailable. Please try again.' });
  }

  if (!stored) {
    return res.status(400).json({ valid: false, error: 'OTP expired. Please request a new one.' });
  }

  if (String(stored) !== String(otp)) {
    return res.status(400).json({ valid: false, error: 'Incorrect OTP' });
  }

  /* ── Valid — delete OTP so it can't be reused ── */
  try {
    await redis.del(`otp:${mobile}`);
    await redis.del(`verify_attempts:${mobile}`);
  } catch (err) {
    console.error('[verify-otp] redis cleanup error:', err.message);
    // Still return valid — the OTP matched, cleanup failure isn't the client's problem
  }

  return res.status(200).json({ valid: true });
}
