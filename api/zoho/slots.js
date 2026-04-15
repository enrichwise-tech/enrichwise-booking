/**
 * GET /api/zoho/slots?track=instant|callback&days=7
 *
 * Returns real available slots from Zoho Bookings for the next N days.
 *
 * Zoho Bookings /availableslots requires: service_id, staff_id, selected_date.
 *
 * Env overrides (optional):
 *   ZOHO_INSTANT_SERVICE_ID
 *   ZOHO_CALLBACK_SERVICE_ID
 *   ZOHO_INSTANT_STAFF_ID
 *   ZOHO_CALLBACK_STAFF_ID
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC   = '279048000000841122';
const DEFAULT_CALLBACK_SVC  = '279048000000841186';
// First staff id from the assigned_staffs array on both services
const DEFAULT_STAFF_ID      = '279048000000288162';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Zoho Bookings expects dates in "dd-MMM-yyyy" format, e.g. 16-Apr-2026
function formatZohoDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${pad2(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const track = req.query.track;
  const days = Math.min(parseInt(req.query.days || '7', 10) || 7, 14);

  let serviceId, staffId;
  if (track === 'instant') {
    serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;
    staffId   = process.env.ZOHO_INSTANT_STAFF_ID   || DEFAULT_STAFF_ID;
  } else if (track === 'callback') {
    serviceId = process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC;
    staffId   = process.env.ZOHO_CALLBACK_STAFF_ID   || DEFAULT_STAFF_ID;
  } else {
    return res.status(400).json({ error: 'Missing or invalid track (expected instant|callback)' });
  }

  try {
    const today = new Date();
    const results = [];
    const debug = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr = formatZohoDate(d);
      const iso = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

      const r = await zohoGet('/bookings/v1/json/availableslots', {
        service_id: serviceId,
        staff_id: staffId,
        selected_date: dateStr
      });

      if (!r.ok) {
        console.warn('[zoho/slots] non-ok for', dateStr, r.status, JSON.stringify(r.data).slice(0, 300));
        debug.push({ date: dateStr, status: r.status, error: r.data });
        continue;
      }

      // Log the raw shape once on day 0 so we can see what Zoho actually returns
      if (i === 0) console.log('[zoho/slots] raw response for', dateStr, ':', JSON.stringify(r.data).slice(0, 800));

      const rv = r.data?.response?.returnvalue;
      let rawSlots = [];
      if (Array.isArray(rv?.data)) rawSlots = rv.data;
      else if (Array.isArray(rv?.response)) rawSlots = rv.response;
      else if (Array.isArray(rv)) rawSlots = rv;
      else if (rv && typeof rv === 'object') {
        rawSlots = Object.values(rv).filter(v => typeof v === 'string');
      }

      // Zoho prepends the timezone name (e.g. "Asia/Calcutta") and emits
      // "Slots Not Available" when a day has none. Keep only strings that
      // look like a clock time.
      const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
      const slots = rawSlots
        .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
        .filter(s => timePattern.test(s));

      if (slots.length > 0) {
        results.push({ date: dateStr, iso, slots });
      }
    }

    return res.status(200).json({
      ok: true,
      service_id: serviceId,
      staff_id: staffId,
      days,
      results,
      ...(debug.length ? { debug } : {})
    });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
