/**
 * GET /api/zoho/slots?track=instant|callback&date=YYYY-MM-DD
 *
 * Returns real available slots from Zoho Bookings for ONE specific date,
 * aggregated across ALL assigned staff so the client sees the union of
 * everyone's availability.
 *
 * Lazy-fetch pattern: the calendar widget only calls this when a date is
 * clicked, so we avoid pre-fetching 30 days × 5 staff = 150 API calls.
 *
 * Response:
 *   {
 *     ok: true,
 *     service_id: "...",
 *     date: "16-Apr-2026",
 *     iso:  "2026-04-16",
 *     slots: [
 *       { time: "10:30 AM", staff_ids: ["...", "..."] },
 *       ...
 *     ]
 *   }
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000733018'; // Private consultation (Online)
const DEFAULT_CALLBACK_SVC = '279048000000841186'; // unused (under-1Cr routes to Zoho Form)

// Assigned staff IDs observed via /api/zoho/info for both TEST services
const STAFF_POOL = [
  '279048000000288162',
  '279048000000371462',
  '279048000000371472',
  '279048000000371482',
  '279048000000655616'
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "2026-04-16" -> "16-Apr-2026" (Zoho's format)
function isoToZoho(iso) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const monthIdx = parseInt(mo, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${d}-${months[monthIdx]}-${y}`;
}

function timeToMinutes(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)?$/i);
  if (!m) return 99999;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = (m[3] || '').toUpperCase();
  if (mer === 'PM' && h < 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

async function fetchSlotsForStaff(serviceId, staffId, dateStr, debug) {
  const r = await zohoGet('/bookings/v1/json/availableslots', {
    service_id: serviceId,
    staff_id: staffId,
    selected_date: dateStr
  });

  if (debug) debug.push({ staffId, status: r.status, ok: r.ok, raw: r.data });

  if (!r.ok) return [];

  const rv = r.data?.response?.returnvalue;
  let raw = [];
  if (Array.isArray(rv?.data)) raw = rv.data;
  else if (Array.isArray(rv?.response)) raw = rv.response;
  else if (Array.isArray(rv)) raw = rv;

  const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
  return raw
    .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
    .filter(s => timePattern.test(s));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const track = req.query.track;
  const iso = req.query.date;

  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' });
  }
  const dateStr = isoToZoho(iso);
  if (!dateStr) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  let serviceId;
  if (track === 'instant') {
    serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;
  } else if (track === 'callback') {
    serviceId = process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC;
  } else {
    return res.status(400).json({ error: 'Missing or invalid track (expected instant|callback)' });
  }

  const isDebug = req.query.debug === '1';
  const debugLog = isDebug ? [] : null;

  // First try without staff_id — services with let_customer_select_staff=true
  // return aggregated service-level availability this way. If that returns
  // slots, we use them directly. Fall back to per-staff union if empty.
  async function fetchServiceLevel() {
    const r = await zohoGet('/bookings/v1/json/availableslots', {
      service_id: serviceId,
      selected_date: dateStr
    });
    if (debugLog) debugLog.push({ mode: 'service_only', status: r.status, ok: r.ok, raw: r.data });
    if (!r.ok) return [];
    const rv = r.data?.response?.returnvalue;
    let raw = [];
    if (Array.isArray(rv?.data)) raw = rv.data;
    else if (Array.isArray(rv?.response)) raw = rv.response;
    else if (Array.isArray(rv)) raw = rv;
    const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
    return raw
      .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
      .filter(s => timePattern.test(s));
  }

  try {
    // Attempt service-level query first
    const serviceLevelSlots = await fetchServiceLevel();

    // If service-level returned slots, short-circuit — every slot is available
    // to all staff in the pool (Zoho auto-assigns)
    if (serviceLevelSlots.length > 0) {
      const sortedSlots = serviceLevelSlots
        .sort((a, b) => timeToMinutes(a) - timeToMinutes(b))
        .map(time => ({ time, staff_ids: STAFF_POOL }));
      return res.status(200).json({
        ok: true,
        service_id: serviceId,
        date: dateStr,
        iso,
        slots: sortedSlots,
        ...(isDebug ? { debug: debugLog, mode: 'service_level' } : {})
      });
    }

    // Fall back to per-staff union
    const staffResults = await Promise.all(
      STAFF_POOL.map(async (sid) => {
        try {
          const slots = await fetchSlotsForStaff(serviceId, sid, dateStr, debugLog);
          return { sid, slots };
        } catch (err) {
          console.warn('[zoho/slots] staff', sid, 'failed for', dateStr, err.message);
          if (debugLog) debugLog.push({ staffId: sid, error: err.message });
          return { sid, slots: [] };
        }
      })
    );

    const timeMap = new Map();
    for (const { sid, slots } of staffResults) {
      for (const t of slots) {
        if (!timeMap.has(t)) timeMap.set(t, []);
        timeMap.get(t).push(sid);
      }
    }

    const sortedSlots = Array.from(timeMap.entries())
      .sort((a, b) => timeToMinutes(a[0]) - timeToMinutes(b[0]))
      .map(([time, staff_ids]) => ({ time, staff_ids }));

    return res.status(200).json({
      ok: true,
      service_id: serviceId,
      date: dateStr,
      iso,
      slots: sortedSlots,
      ...(isDebug ? { debug: debugLog, mode: 'per_staff_union' } : {})
    });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
