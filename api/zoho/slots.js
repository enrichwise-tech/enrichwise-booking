/**
 * GET /api/zoho/slots?track=instant|callback&days=7
 *
 * Returns real available slots from Zoho Bookings for the next N days.
 *
 * Env vars:
 *   ZOHO_INSTANT_SERVICE_ID  — service ID for ₹1Cr+ (Priority Wealth Session)
 *   ZOHO_CALLBACK_SERVICE_ID — service ID for < ₹1Cr (Discovery Call)
 *   Defaults to the IDs derived from the existing Zoho booking URLs.
 */
import { zohoGet } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000841122';
const DEFAULT_CALLBACK_SVC = '279048000000841186';

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

      const r = await zohoGet('/bookings/v1/json/availableslots', {
        service_id: serviceId,
        selected_date: dateStr
      });

      if (!r.ok) {
        console.warn('[zoho/slots] failed for', dateStr, r.data);
        continue;
      }

      const slots = r.data?.response?.returnvalue?.data || [];
      if (slots.length > 0) {
        results.push({ date: dateStr, iso: d.toISOString().slice(0, 10), slots });
      }
    }

    return res.status(200).json({ ok: true, service_id: serviceId, days, results });
  } catch (err) {
    console.error('[zoho/slots] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
