/**
 * GET /api/zoho/slots?track=instant|callback&date=YYYY-MM-DD
 * GET /api/zoho/slots?track=instant&summary=1
 *
 * Two modes:
 *   1. Per-date (default): Returns real available slots from Zoho Bookings
 *      for ONE specific date. Used when the user clicks a date on the calendar.
 *   2. Summary: Returns {iso, has_slots} for the next 15 days (the maximum
 *      booking notice configured in Zoho). Used by the frontend to grey out
 *      dates with no availability and auto-jump to the soonest open date,
 *      so clients don't have to click each date hunting for a free one.
 *
 * Single service-level Zoho call per date — Zoho aggregates across all assigned
 * staff and applies service window, blocked times, and one-booking-per-customer
 * constraints. The booking POST (book.js) auto-assigns staff, so we don't need
 * per-staff data here.
 *
 * Per-date response:
 *   {
 *     ok: true,
 *     service_id: "...",
 *     date: "16-Apr-2026",
 *     iso:  "2026-04-16",
 *     slots: [
 *       { time: "10:30 AM", staff_ids: [] },
 *       ...
 *     ]
 *   }
 *
 * Summary response:
 *   {
 *     ok: true,
 *     service_id: "...",
 *     dates: [
 *       { iso: "2026-05-04", has_slots: true },
 *       { iso: "2026-05-05", has_slots: false },
 *       ...
 *     ]
 *   }
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000733018'; // Private consultation (Online)
const DEFAULT_CALLBACK_SVC = '279048000000841186'; // unused (under-1Cr routes to Zoho Form)
const SUMMARY_DAYS         = 15; // matches Zoho service "Maximum Booking Notice"

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

// Fetch raw available time strings for a given service + date.
async function fetchTimes(serviceId, dateStr) {
  const r = await zohoGet('/bookings/v1/json/availableslots', {
    service_id: serviceId,
    selected_date: dateStr
  });
  if (!r.ok) return { ok: false, times: [], raw: r.data };
  const rv = r.data?.response?.returnvalue;
  let raw = [];
  if (Array.isArray(rv?.data)) raw = rv.data;
  else if (Array.isArray(rv?.response)) raw = rv.response;
  else if (Array.isArray(rv)) raw = rv;
  const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
  const times = raw
    .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
    .filter(s => timePattern.test(s));
  return { ok: true, times: applyOneHourCutoff(times, dateStr), raw: r.data };
}

// Drop any slot that isn't strictly more than 1 hour away in IST.
// Zoho's REST API only enforces >= 1 hour (the configured Minimum Booking
// Notice), but Zoho's own widget is stricter and excludes slots exactly at
// the 1-hour boundary. This filter aligns our app with the widget behaviour.
const MONTH_NAME_TO_NUM = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
function applyOneHourCutoff(times, dateStr) {
  const m = String(dateStr).match(/^(\d{1,2})-(\w{3})-(\d{4})$/);
  if (!m) return times;
  const [, dStr, monStr, yStr] = m;
  const mo = MONTH_NAME_TO_NUM[monStr];
  if (!mo) return times;
  const y = yStr;
  const d = pad2(dStr);
  const moStr = pad2(mo);

  const thresholdMs = Date.now() + 60 * 60 * 1000; // now + 1 hour, in UTC ms

  return times.filter(t => {
    const tm = t.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)?$/i);
    if (!tm) return true;
    let hh = parseInt(tm[1], 10);
    const mm = parseInt(tm[2], 10);
    const mer = (tm[3] || '').toUpperCase();
    if (mer === 'PM' && hh < 12) hh += 12;
    if (mer === 'AM' && hh === 12) hh = 0;
    // Slot is in IST (Asia/Calcutta = UTC+5:30). Build an ISO string with the
    // explicit offset so Date.parse converts it to a correct UTC ms timestamp.
    const iso = `${y}-${moStr}-${d}T${pad2(hh)}:${pad2(mm)}:00+05:30`;
    const slotMs = Date.parse(iso);
    if (isNaN(slotMs)) return true;
    return slotMs > thresholdMs;
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const track = req.query.track;
  const isSummary = req.query.summary === '1';
  const iso = req.query.date;

  let serviceId;
  if (track === 'instant') {
    serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;
  } else if (track === 'callback') {
    serviceId = process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC;
  } else {
    return res.status(400).json({ error: 'Missing or invalid track (expected instant|callback)' });
  }

  const isDebug = req.query.debug === '1';

  // ── Summary mode ──────────────────────────────────────────────────────────
  if (isSummary) {
    try {
      // Generate ISO dates for today + next (SUMMARY_DAYS - 1) days. Today is
      // included because Zoho's minBookingNotice is short (1 hr) — same-day
      // slots can still be available later in the day.
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const items = [];
      for (let i = 0; i < SUMMARY_DAYS; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() + i);
        const isoStr = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
        items.push({ iso: isoStr, dateStr: isoToZoho(isoStr) });
      }

      const results = await Promise.all(items.map(async ({ iso, dateStr }) => {
        try {
          const r = await fetchTimes(serviceId, dateStr);
          return { iso, has_slots: r.ok && r.times.length > 0 };
        } catch (err) {
          // Don't fail the whole summary on one bad date — just mark it unknown.
          console.warn('[zoho/slots] summary fetch failed for', dateStr, err.message);
          return { iso, has_slots: false };
        }
      }));

      return res.status(200).json({
        ok: true,
        service_id: serviceId,
        dates: results
      });
    } catch (err) {
      console.error('[zoho/slots] summary error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Per-date mode (existing behaviour) ────────────────────────────────────
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' });
  }
  const dateStr = isoToZoho(iso);
  if (!dateStr) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  try {
    const r = await fetchTimes(serviceId, dateStr);
    if (!r.ok) {
      return res.status(502).json({
        error: 'Zoho availableslots failed',
        ...(isDebug ? { raw: r.raw } : {})
      });
    }

    const sortedSlots = r.times
      .sort((a, b) => timeToMinutes(a) - timeToMinutes(b))
      .map(time => ({ time, staff_ids: [] }));

    return res.status(200).json({
      ok: true,
      service_id: serviceId,
      date: dateStr,
      iso,
      slots: sortedSlots,
      ...(isDebug ? { raw: r.raw } : {})
    });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
