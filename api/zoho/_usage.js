/**
 * Counts this site's Zoho API calls per IST day in Redis, so usage can be
 * checked at /api/events?key=<ZOHO_INFO_KEY>&usage=1
 *
 * Only calls made by this site are counted. Other tools on the same Zoho
 * account (such as LeadFlow) are not. A counting failure never blocks the call.
 *
 * BATCHED since 27-Nov-26. Counting each call straight away cost 3 database
 * commands a call, about 9,000 a day, nearly half of what pushed the database
 * past Upstash's free monthly limit. Now:
 *   - The two bulk calls (availableslots, fetchappointment: about 95% of all
 *     calls) are held in memory and written in one go, either at the end of
 *     the request (flushZohoUsage(), called by slots.js, book.js and
 *     reconcile-events.js) or once FLUSH_AT calls are waiting.
 *   - Every other call is written straight away, as before.
 *   - The day key's expiry is set once per instance per day, not every call.
 * A batch is only lost if an instance dies mid-request, so the daily totals
 * can read very slightly low. They are a monitoring figure, not a bill.
 */
import { getRedis } from '../_redis.js';

const KEEP_DAYS = 40;
const FLUSH_AT = 25;
const BULK_LABELS = new Set(['bookings:availableslots', 'bookings:fetchappointment']);

const pending = new Map(); // day key -> Map(label -> n)
let pendingCalls = 0;
const expirySet = new Set(); // day keys this instance has already set an expiry on

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

function add(key, field, n) {
  if (!pending.has(key)) pending.set(key, new Map());
  const m = pending.get(key);
  m.set(field, (m.get(field) || 0) + n);
}

/** Write whatever is waiting. Safe to call when nothing is. */
export async function flushZohoUsage() {
  if (!pendingCalls) return;
  const batch = [...pending.entries()];
  pending.clear();
  pendingCalls = 0;
  try {
    const p = getRedis().pipeline();
    for (const [key, fields] of batch) {
      for (const [field, n] of fields) p.hincrby(key, field, n);
      if (!expirySet.has(key)) {
        expirySet.add(key);
        p.expire(key, KEEP_DAYS * 86400);
      }
    }
    await p.exec();
  } catch (err) {
    console.warn('[zoho/usage] could not record calls:', err.message);
  }
}

export async function recordZohoCall(path, { limited = false } = {}) {
  const key = `zoho:usage:${istDate(Date.now())}`;
  const label = labelFor(path);
  add(key, 'total', 1);
  add(key, label, 1);
  if (limited) add(key, 'rate_limited', 1);
  pendingCalls++;
  if (!BULK_LABELS.has(label) || pendingCalls >= FLUSH_AT) await flushZohoUsage();
}

// Newest day first: [{ date, total, rate_limited, by_call: { label: n } }]
export async function getZohoUsage(days = 14) {
  await flushZohoUsage();
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

// For tests only.
export function _pendingZohoCalls() {
  return pendingCalls;
}
