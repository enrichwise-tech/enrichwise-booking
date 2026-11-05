/**
 * Counts this site's Zoho API calls per IST day in Redis, so usage can be
 * checked at /api/events?key=<ZOHO_INFO_KEY>&usage=1
 *
 * Only calls made by this site are counted. Other tools on the same Zoho
 * account (such as LeadFlow) are not. A counting failure never blocks the call.
 */
import { getRedis } from '../_redis.js';

const KEEP_DAYS = 40;

function istDate(ms) {
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
}

// "/bookings/v1/json/availableslots" -> "bookings:availableslots"
function labelFor(path) {
  const clean = String(path).replace(/\/\d{6,}/g, '');
  if (clean.startsWith('/bookings/v1/json/')) return `bookings:${clean.slice(18)}`;
  if (clean.startsWith('/crm/')) return `crm:${clean.split('/').slice(3).join('/')}`;
  return clean;
}

export async function recordZohoCall(path, { limited = false } = {}) {
  try {
    const key = `zoho:usage:${istDate(Date.now())}`;
    const p = getRedis().pipeline();
    p.hincrby(key, 'total', 1);
    p.hincrby(key, labelFor(path), 1);
    if (limited) p.hincrby(key, 'rate_limited', 1);
    p.expire(key, KEEP_DAYS * 86400);
    await p.exec();
  } catch (err) {
    console.warn('[zoho/usage] could not record call:', err.message);
  }
}

// Newest day first: [{ date, total, rate_limited, by_call: { label: n } }]
export async function getZohoUsage(days = 14) {
  const redis = getRedis();
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = istDate(Date.now() - i * 86400000);
    const h = (await redis.hgetall(`zoho:usage:${date}`)) || {};
    const { total = 0, rate_limited = 0, ...by_call } = h;
    out.push({ date, total: Number(total), rate_limited: Number(rate_limited), by_call });
  }
  return out;
}
