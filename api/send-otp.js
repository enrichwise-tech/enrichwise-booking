/**
 * POST /api/send-otp
 * Body: { mobile: "9876543210" }
 *
 * Generates a 6-digit OTP, stores it in Vercel KV with a 10-min TTL,
 * then sends it via WATI WhatsApp template message.
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

  const { mobile } = body;

  /* ── Validate mobile ── */
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return new Response(
      JSON.stringify({ error: 'Please enter a valid 10-digit mobile number' }),
      { status: 400, headers: CORS }
    );
  }

  /* ── Rate limit: max 3 OTPs per mobile per 10 minutes ── */
  const rateLimitKey = `ratelimit:${mobile}`;
  const attempts = await kv.incr(rateLimitKey);
  if (attempts === 1) await kv.expire(rateLimitKey, 600); // 10 min window
  if (attempts > 3) {
    return new Response(
      JSON.stringify({ error: 'Too many attempts. Please try again after 10 minutes.' }),
      { status: 429, headers: CORS }
    );
  }

  /* ── Generate OTP ── */
  const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits

  /* ── Reset wrong-attempt counter from any previous OTP on this number ── */
  await kv.del(`verify_attempts:${mobile}`);

  /* ── Store OTP in KV with 10-minute TTL ── */
  await kv.set(`otp:${mobile}`, otp, { ex: 600 });

  /* ── Send via WATI ── */
  const watiEndpoint = `${process.env.WATI_API_URL}/api/v1/sendTemplateMessage`;

  const watiPayload = {
    template_name: process.env.WATI_TEMPLATE_NAME, // e.g. "otp_verification"
    broadcast_name: `otp_${mobile}_${Date.now()}`,
    receivers: [
      {
        whatsappNumber: `91${mobile}`,
        customParams: [
          { name: '1', value: otp },           // {{1}} in your template = OTP
          { name: '2', value: '10 minutes' }   // {{2}} = expiry (optional)
        ]
      }
    ]
  };

  const watiRes = await fetch(watiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.WATI_API_TOKEN}`
    },
    body: JSON.stringify(watiPayload)
  });

  if (!watiRes.ok) {
    const err = await watiRes.text();
    console.error('WATI error:', err);
    return new Response(
      JSON.stringify({ error: 'Could not send OTP. Please try again.' }),
      { status: 502, headers: CORS }
    );
  }

  return new Response(
    JSON.stringify({ success: true, message: 'OTP sent via WhatsApp' }),
    { status: 200, headers: CORS }
  );
}
