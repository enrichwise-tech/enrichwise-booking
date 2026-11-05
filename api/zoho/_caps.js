/**
 * Daily booking caps per consultation, and the calendar's booking window.
 *
 * KEEP THESE IN STEP WITH ZOHO. Zoho's API does not return "Slots per Event
 * Type" or "Maximum Booking Notice", so if either changes in Zoho Bookings
 * (Consultation > Availability and Limits / Scheduling Rules) change it here too.
 *
 * Why the site checks at all: Zoho applies "Slots per Event Type" on its own
 * booking page, but bookings made through the API went past it (main reached
 * 50-54 a day against a cap of 36). Caps are per consultation, not combined.
 * Bookings already made are never touched, and team bookings made directly in
 * Zoho can still go past a cap.
 */
import { zohoGet } from './_client.js';
import { getRedis } from '../_redis.js';
import { sendAlert } from '../_alert.js';

const DEFAULT_MAIN_SVC   = '279048000000733018'; // Private consultation (Online)
const DEFAULT_SECOND_SVC = '279048000001524162'; // Private consultation (Online ), 8-10 days' notice

export const MAIN_DAILY_CAP   = 42; // 6 consultants x 7
export const SECOND_DAILY_CAP = 16; // 8 consultants x 2

// Longest Maximum Booking Notice across the consultations (main = 18 days).
export const BOOKING_HORIZON_DAYS = 18;

const COUNT_CACHE_TTL = 600;      // seconds; how stale a booked count may be while browsing
const LAST_KNOWN_TTL  = 86400;    // seconds; last good count, used if Zoho can't be read
const ALERT_THROTTLE  = 3600;     // seconds; at most one "can't read counts" alert an hour

function dailyCapFor(serviceId) {
  const main   = (process.env.ZOHO_INSTANT_SERVICE_ID  || DEFAULT_MAIN_SVC).trim();
  const second = (process.env.ZOHO_PRIORITY_SERVICE_ID || DEFAULT_SECOND_SVC).trim();
  if (serviceId === main) return MAIN_DAILY_CAP;
  if (serviceId === second) return SECOND_DAILY_CAP;
  return null;
}

const countKey = (serviceId, dateStr) => `zoho:count:${serviceId}:${dateStr}`;
const lastKey  = (serviceId, dateStr) => `zoho:count_last:${serviceId}:${dateStr}`;

// Non-cancelled bookings for one consultation on one "DD-Mon-YYYY" date. Zoho
// returns 50 a page, so stops as soon as the cap is reached: usually one call.
async function readCountFromZoho(serviceId, dateStr, cap) {
  let count = 0;
  for (let page = 1; page <= 10; page++) {
    const r = await zohoGet('/bookings/v1/json/fetchappointment', {
      data: JSON.stringify({
        from_time: `${dateStr} 00:00:00`,
        to_time: `${dateStr} 23:59:59`,
        service_id: serviceId,
        page
      })
    });
    const rv = r.data?.response?.returnvalue;
    if (!r.ok || !rv) throw new Error(`fetchappointment failed: status ${r.status}`);
    if (typeof rv.response === 'string') return count; // "No Match Found"
    if (!Array.isArray(rv.response)) throw new Error('fetchappointment returned an unexpected shape');
    for (const b of rv.response) {
      if (b.service_id === serviceId && !/cancel/i.test(b.status || '')) count++;
    }
    if (count >= cap || !rv.next_page_available) return count;
  }
  return count;
}

function alertOnce(serviceId, dateStr, message) {
  (async () => {
    const redis = getRedis();
    const first = await redis.set('zoho:count_alert', '1', { nx: true, ex: ALERT_THROTTLE });
    if (first) await sendAlert('Booked count could not be read', { date: dateStr, service: serviceId, error: message, effect: 'Website using last known count, or selling if none' });
  })().catch(() => {});
}

/**
 * Is this consultation full for this date?
 * fresh: true skips the 10-minute cache (used when a client confirms a booking).
 *
 * If the count can't be read: use the last known count, and if there is none,
 * treat the date as open and alert PL Case Track. A Zoho hiccup then can't hide
 * every slot from clients, at the risk of occasionally going over a cap.
 */
export async function checkCap(serviceId, dateStr, { fresh = false } = {}) {
  const cap = dailyCapFor(serviceId);
  if (cap === null) return { atCap: false, count: null, cap: null, source: 'no_cap' };

  let redis = null;
  try { redis = getRedis(); } catch {}

  if (!fresh && redis) {
    try {
      const cached = await redis.get(countKey(serviceId, dateStr));
      if (cached !== null && cached !== undefined) {
        const count = Number(cached);
        return { atCap: count >= cap, count, cap, source: 'cache' };
      }
    } catch {}
  }

  try {
    const count = await readCountFromZoho(serviceId, dateStr, cap);
    if (redis) {
      try {
        await redis.set(countKey(serviceId, dateStr), count, { ex: COUNT_CACHE_TTL });
        await redis.set(lastKey(serviceId, dateStr), count, { ex: LAST_KNOWN_TTL });
      } catch {}
    }
    return { atCap: count >= cap, count, cap, source: 'zoho' };
  } catch (err) {
    console.warn('[zoho/caps] count read failed for', serviceId, dateStr, err.message);
    alertOnce(serviceId, dateStr, err.message);
    if (redis) {
      try {
        const last = await redis.get(lastKey(serviceId, dateStr));
        if (last !== null && last !== undefined) {
          const count = Number(last);
          return { atCap: count >= cap, count, cap, source: 'last_known' };
        }
      } catch {}
    }
    return { atCap: false, count: null, cap, source: 'unknown' };
  }
}

// After a booking lands, forget the cached count so the next read is correct.
export async function clearCountCache(serviceId, dateStr) {
  try { await getRedis().del(countKey(serviceId, dateStr)); } catch {}
}
