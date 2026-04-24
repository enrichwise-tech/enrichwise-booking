/**
 * GET /api/zoho/test-book-no-staff?key=<ZOHO_INFO_KEY>&date=28-Apr-2026&time=12:30%20PM
 *
 * Probe whether Zoho Bookings' /appointment POST accepts a request WITHOUT
 * staff_id. If it does, the booking app can drop the entire per-staff
 * fan-out (in slots.js) and retry loop (in book.js) — see slots.js comment
 * about the Apr 2026 spurious-failure investigation.
 *
 * Returns the raw Zoho response so we can see exactly what was accepted/rejected.
 *
 * If a booking is actually created, DELETE IT MANUALLY from Zoho Bookings
 * after verification.
 *
 * Defaults pick a slot likely to be valid; pass ?date=...&time=... to override.
 */
import { zohoPost } from './_client.js';

const DEFAULT_INSTANT_SVC = '279048000000733018'; // Private consultation (Online)
const TIME_ZONE           = 'Asia/Calcutta';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function to24Hour(slot) {
  const m = String(slot).trim().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = (m[3] || '').toUpperCase();
  if (mer === 'PM' && h < 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return `${pad2(h)}:${pad2(min)}:00`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = (process.env.ZOHO_INFO_KEY || '').trim();
  const provided = (req.query.key || '').trim();
  if (!expected || provided !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const date = (req.query.date || '28-Apr-2026').trim();
  const time = (req.query.time || '12:30 PM').trim();
  const time24 = to24Hour(time);
  if (!time24) return res.status(400).json({ error: `Could not parse time "${time}"` });

  const serviceId = process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC;

  const customerDetails = {
    name: 'Auto-assign Probe',
    email: 'probe-no-staff@enrichwise.local',
    phone_number: '+910000000002'
  };

  const additionalFields = {
    'I want to discuss': 'Investments',
    'Preferred mode': 'Normal call',
    'Which platform are you currently using for Investments': 'n/a',
    'Please describe your query in brief': 'Auto-assign probe — delete after verification.'
  };

  const formBody = {
    service_id: serviceId,
    // staff_id intentionally OMITTED — this is the whole point of the probe
    from_time: `${date} ${time24}`,
    customer_details: JSON.stringify(customerDetails),
    additional_fields: JSON.stringify(additionalFields),
    time_zone: TIME_ZONE,
    notes: 'test-book-no-staff probe'
  };

  console.log('[test-book-no-staff] sending without staff_id:', formBody);

  try {
    const r = await zohoPost('/bookings/v1/json/appointment', formBody);
    const rv = r.data?.response?.returnvalue || {};
    const innerStatus = rv.status || r.data?.response?.status;
    const innerMessage = rv.message || '';
    const created = !!(rv.booking_id || rv.id);

    return res.status(200).json({
      ok: true,
      verdict: created
        ? 'ZOHO ACCEPTS WITHOUT staff_id — auto-assign works. Safe to drop per-staff logic. DELETE this test booking from Zoho Bookings manually.'
        : 'ZOHO REJECTED without staff_id — must keep sending staff_id. See zoho_message.',
      created,
      booking_id: rv.booking_id || rv.id || null,
      assigned_staff_id: rv.staff_id || rv.staffId || null,
      http_status: r.status,
      inner_status: innerStatus,
      zoho_message: innerMessage,
      raw: r.data
    });
  } catch (err) {
    console.error('[test-book-no-staff] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
