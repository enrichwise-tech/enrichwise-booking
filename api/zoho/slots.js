/**
 * GET /api/zoho/slots?track=instant|callback&days=7
 *
 * Returns real available slots from Zoho Bookings for the next N days,
 * aggregated across ALL assigned staff members for the service so the
 * client sees the union of everyone's availability (not just one advisor).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     service_id: "...",
 *     staff_pool: [...],
 *     results: [
 *       { date: "16-Apr-2026", iso: "2026-04-16", slots: [
 *           { time: "10:30 AM", staff_ids: ["...", "..."] },
 *           ...
 *       ]}
 *     ]
 *   }
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC   = '279048000000841122';
const DEFAULT_CALLBACK_SVC  = '279048000000841186';

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

// Zoho Bookings expects dates in "dd-MMM-yyyy" format
function formatZohoDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${pad2(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// Sort time strings like "10:30 AM" in clock order
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

async function fetchSlotsForStaff(serviceId, staffId, dateStr) {
  const r = await zohoGet('/bookings/v1/json/availableslots', {
    service_id: serviceId,
    staff_id: staffId,
    selected_date: dateStr
  });

  if (!r.ok) return [];

  const rv = r.data?.response?.returnvalue;
  let raw = [];
  if (Array.isArray(rv?.data)) raw = rv.data;
  else if (Array.isArray(rv?.response)) raw = rv.response;
  else if (Array.isArray(rv)) raw = rv;

  // Filter out timezone markers and "Slots Not Available" noise
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
  const days = Math.min(parseInt(req.query.days || '7', 10) || 7, 14);

  let serviceId;
  if (track === 'instant') {
    serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;
  } else if (track === 'callback') {
    serviceId = process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC;
  } else {
    return res.status(400).json({ error: 'Missing or invalid track (expected instant|callback)' });
  }

  try {
    const today = new Date();
    const results = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr = formatZohoDate(d);
      const iso = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

      // Fan out to all staff in parallel
      const staffResults = await Promise.all(
        STAFF_POOL.map(async (sid) => {
          try {
            const slots = await fetchSlotsForStaff(serviceId, sid, dateStr);
            return { sid, slots };
          } catch (err) {
            console.warn('[zoho/slots] staff', sid, 'failed for', dateStr, err.message);
            return { sid, slots: [] };
          }
        })
      );

      // Merge into time -> [staff_ids] map
      const timeMap = new Map();
      for (const { sid, slots } of staffResults) {
        for (const t of slots) {
          if (!timeMap.has(t)) timeMap.set(t, []);
          timeMap.get(t).push(sid);
        }
      }

      if (timeMap.size === 0) continue;

      const sortedSlots = Array.from(timeMap.entries())
        .sort((a, b) => timeToMinutes(a[0]) - timeToMinutes(b[0]))
        .map(([time, staff_ids]) => ({ time, staff_ids }));

      results.push({ date: dateStr, iso, slots: sortedSlots });
    }

    return res.status(200).json({
      ok: true,
      service_id: serviceId,
      staff_pool: STAFF_POOL,
      days,
      results
    });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
