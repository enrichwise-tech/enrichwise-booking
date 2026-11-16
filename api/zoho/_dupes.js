/**
 * Stops the same person booking twice without meaning to.
 *
 * WHY: Zoho's own "Slots per Customer" limit only applies to bookings made on
 * Zoho's booking page. Bookings this site makes go in through the API and are
 * not counted against it, so the limit never fires for them. On 17-Nov-2026
 * one client held two consultants at 5:15 pm, both booked through this site
 * 34 minutes apart (#EN-13197 / #EN-13198), and Zoho allowed it.
 *
 * HOW: every booking this site makes is remembered in Redis against the
 * mobile number, and the daily reconciler refreshes the whole index from Zoho
 * so bookings made on Zoho's page or by the team are known too. Before
 * creating a booking we look the mobile up. A hit is a warning the customer
 * can click past (confirm_duplicate), never a hard block: two consultations
 * on purpose is legitimate, and this must never be the reason a real booking
 * fails.
 *
 * Costs no Zoho calls. One Redis read per booking attempt, one write on
 * success.
 */
import { getRedis } from '../_redis.js';

const INDEX_TTL   = 60 * 60 * 24 * 40; // seconds; comfortably past the 18-day booking window
const MAX_ENTRIES = 6;                 // per mobile; newest kept

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const pad2 = n => String(n).padStart(2, '0');

// Digits-only international number, e.g. "919930997761". Matches how Zoho
// stores customer_contact_no once the "+" is stripped, so the index built
// from Zoho lines up with the one this site writes.
export function mobileKey(countryCode, mobile) {
  const cc    = String(countryCode || '').replace(/\D/g, '');
  const local = String(mobile || '').replace(/\D/g, '');
  const full  = `${cc}${local}`;
  return full.length >= 10 ? full : '';
}

export function mobileKeyFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : '';
}

// "16-Nov-2026" -> "2026-11-16". Returns '' for anything unexpected.
export function bookingsDateToIso(dateStr) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(dateStr || '').trim());
  if (!m) return '';
  const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return '';
  return `${m[3]}-${pad2(mi + 1)}-${pad2(parseInt(m[1], 10))}`;
}

// Today in IST as YYYY-MM-DD.
export function istTodayIso() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000 - now.getTimezoneOffset() * 60 * 1000);
  return `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}`;
}

const indexKey = digits => `booking:mob:${digits}`;

function parseEntries(raw) {
  if (!raw) return [];
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v.filter(e => e && e.iso) : [];
}

/**
 * The customer's earliest booking that has not happened yet, or null. Never
 * throws: if Redis is unreadable the booking goes ahead unchecked.
 */
export async function findUpcomingBooking(countryCode, mobile) {
  const digits = mobileKey(countryCode, mobile);
  if (!digits) return null;
  try {
    const entries = parseEntries(await getRedis().get(indexKey(digits)));
    const today = istTodayIso();
    const future = entries.filter(e => e.iso >= today).sort((a, b) => (a.iso + a.time24).localeCompare(b.iso + b.time24));
    return future[0] || null;
  } catch (err) {
    console.warn('[dupes] lookup failed, letting the booking through:', err.message);
    return null;
  }
}

/** Remember a booking this site just made. Never throws. */
export async function rememberBooking(countryCode, mobile, entry) {
  const digits = mobileKey(countryCode, mobile);
  if (!digits) return;
  const iso = bookingsDateToIso(entry.date);
  if (!iso) return;
  try {
    const redis = getRedis();
    const key = indexKey(digits);
    const entries = parseEntries(await redis.get(key))
      .filter(e => e.iso >= istTodayIso() && e.booking_id !== entry.booking_id);
    entries.push({
      iso,
      date: entry.date,
      slot: entry.slot || '',
      time24: entry.time24 || '',
      booking_id: entry.booking_id || '',
      service_id: entry.service_id || ''
    });
    await redis.set(key, JSON.stringify(entries.slice(-MAX_ENTRIES)), { ex: INDEX_TTL });
  } catch (err) {
    console.warn('[dupes] could not record the booking:', err.message);
  }
}

/**
 * Move an entry to a new time after a reschedule, so the warning shows the
 * booking where it actually is now. Never throws.
 */
export async function updateBookingTime(countryCode, mobile, bookingId, entry) {
  const digits = mobileKey(countryCode, mobile);
  const iso = bookingsDateToIso(entry.date);
  if (!digits || !iso) return;
  try {
    const redis = getRedis();
    const key = indexKey(digits);
    const entries = parseEntries(await redis.get(key)).filter(e => e.booking_id !== bookingId);
    entries.push({
      iso,
      date: entry.date,
      slot: entry.slot || '',
      time24: entry.time24 || '',
      booking_id: bookingId,
      service_id: entry.service_id || ''
    });
    await redis.set(key, JSON.stringify(entries.slice(-MAX_ENTRIES)), { ex: INDEX_TTL });
  } catch (err) {
    console.warn('[dupes] could not update the booking:', err.message);
  }
}

/**
 * Rebuild the whole index from a list of Zoho bookings (the daily reconciler
 * already holds them). This is what makes bookings made on Zoho's own page,
 * or by the team inside Zoho, visible to the check. Cancelled bookings are
 * dropped, so a cancel-and-rebook clears itself within a day.
 * Returns how many mobiles were written.
 */
export async function rebuildDuplicateIndex(bookings) {
  const today = istTodayIso();
  const byMobile = new Map();
  for (const b of bookings || []) {
    if (/cancel/i.test(b.status || '')) continue;
    const digits = mobileKeyFromPhone(b.customer_contact_no);
    if (!digits) continue;
    const iso = bookingsDateToIso((b.start_time || '').slice(0, 11));
    if (!iso || iso < today) continue;
    const time24 = (b.start_time || '').slice(12, 17);
    if (!byMobile.has(digits)) byMobile.set(digits, []);
    byMobile.get(digits).push({
      iso,
      date: (b.start_time || '').slice(0, 11),
      slot: time24,
      time24,
      booking_id: (b.booking_id || '').replace(/^#/, ''),
      service_id: b.service_id || ''
    });
  }
  if (!byMobile.size) return 0;
  const redis = getRedis();
  let written = 0;
  const all = [...byMobile.entries()];
  for (let i = 0; i < all.length; i += 50) {
    const pipe = redis.pipeline();
    for (const [digits, entries] of all.slice(i, i + 50)) {
      entries.sort((a, b2) => (a.iso + a.time24).localeCompare(b2.iso + b2.time24));
      pipe.set(indexKey(digits), JSON.stringify(entries.slice(-MAX_ENTRIES)), { ex: INDEX_TTL });
      written++;
    }
    await pipe.exec();
  }
  return written;
}
