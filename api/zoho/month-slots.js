/**
 * GET /api/zoho/month-slots?track=instant|callback&year=2026&month=5
 *
 * Returns availability counts per day for an entire month. Used by the
 * calendar widget to grey out dates with no slots before the user clicks.
 *
 * Response:
 *   {
 *     ok: true,
 *     year: 2026, month: 5,
 *     counts: { "2026-05-01": 26, "2026-05-02": 0, ... }
 *   }
 *
 * Performance: fires one service-level `availableslots` request per day
 * in parallel (no staff_id, which works for services with
 * let_customer_select_staff=true). Typical response time: 2-5 seconds.
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC = '279048000000733018';
const DEFAULT_CALLBACK_SVC = '279048000000841186';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isoToZoho(iso) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${d}-${months[parseInt(mo, 10) - 1]}-${y}`;
}

async function fetchDayCount(serviceId, dateStr) {
  // Try service-level first (works for let_customer_select_staff=true services)
  const r = await zohoGet('/bookings/v1/json/availableslots', {
    service_id: serviceId,
    selected_date: dateStr
  });
  if (!r.ok) return 0;
  const rv = r.data?.response?.returnvalue;
  let raw = [];
  if (Array.isArray(rv?.data)) raw = rv.data;
  else if (Array.isArray(rv?.response)) raw = rv.response;
  else if (Array.isArray(rv)) raw = rv;
  const timePattern = /^\d{1,2}:\d{2}\s?(AM|PM)?$/i;
  return raw
    .map(s => (typeof s === 'string' ? s.trim() : (s?.time || s?.from_time || '')))
    .filter(s => timePattern.test(s))
    .length;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const track = req.query.track;
  const year = parseInt(req.query.year || '0', 10);
  const month = parseInt(req.query.month || '0', 10); // 1-12

  if (!year || year < 2024 || year > 2100 || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Invalid year/month (expected year=YYYY, month=1-12)' });
  }

  let serviceId;
  if (track === 'instant') {
    serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;
  } else if (track === 'callback') {
    serviceId = process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC;
  } else {
    return res.status(400).json({ error: 'Missing or invalid track' });
  }

  try {
    // Only check dates from today onwards (past dates are never bookable)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();

    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month - 1, d);
      if (date >= today) {
        const iso = `${year}-${pad2(month)}-${pad2(d)}`;
        dates.push({ iso, zoho: isoToZoho(iso) });
      }
    }

    // Fan out all dates in parallel
    const counts = {};
    await Promise.all(dates.map(async ({ iso, zoho }) => {
      try {
        counts[iso] = await fetchDayCount(serviceId, zoho);
      } catch (err) {
        console.warn('[zoho/month-slots] failed for', iso, err.message);
        counts[iso] = 0;
      }
    }));

    return res.status(200).json({
      ok: true,
      year,
      month,
      service_id: serviceId,
      counts
    });
  } catch (err) {
    console.error('[zoho/month-slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
