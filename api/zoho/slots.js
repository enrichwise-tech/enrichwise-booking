/**
 * GET /api/zoho/slots?track=instant|callback&date=YYYY-MM-DD
 *
 * Returns real available slots from Zoho Bookings for ONE specific date.
 *
 * Single service-level call — Zoho aggregates across all assigned staff and
 * applies service window, blocked times, and one-booking-per-customer
 * constraints. The booking POST (book.js) auto-assigns staff, so we don't
 * need to know per-staff availability here.
 *
 * Response:
 *   {
 *     ok: true,
 *     service_id: "...",
 *     date: "16-Apr-2026",
 *     iso:  "2026-04-16",
 *     slots: [
 *       { time: "10:30 AM", staff_ids: [] },   // staff_ids kept for back-compat
 *       ...
 *     ]
 *   }
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000733018'; // Private consultation (Online)
const DEFAULT_CALLBACK_SVC = '279048000000841186'; // unused (under-1Cr routes to Zoho Form)

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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

  try {
    const r = await zohoGet('/bookings/v1/json/availableslots', {
      service_id: serviceId,
      selected_date: dateStr
    });

    if (!r.ok) {
      return res.status(r.status || 502).json({
        error: 'Zoho availableslots failed',
        ...(isDebug ? { raw: r.data } : {})
      });
    }

    const rv = r.data?.response?.returnvalue;
    let raw = [];
    if (Array.isArray(rv?.data)) raw = rv.data;
    else if (Array.isArray(rv?.response)) raw = rv.response;
    else if (Array.isArray(rv)) raw = rv;

    const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
    const times = raw
      .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
      .filter(s => timePattern.test(s));

    const sortedSlots = times
      .sort((a, b) => timeToMinutes(a) - timeToMinutes(b))
      .map(time => ({ time, staff_ids: [] }));

    return res.status(200).json({
      ok: true,
      service_id: serviceId,
      date: dateStr,
      iso,
      slots: sortedSlots,
      ...(isDebug ? { raw: r.data } : {})
    });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
