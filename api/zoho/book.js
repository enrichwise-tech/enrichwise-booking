/**
 * POST /api/zoho/book
 *
 * Creates an appointment in Zoho Bookings.
 *
 * Body:
 *   {
 *     track: "instant" | "callback",
 *     date:  "16-Apr-2026",
 *     slot:  "4:30 PM",
 *     name:  "Manish Sharma",
 *     email: "manish@example.com",
 *     mobile:"9876543210",
 *     corpus:"₹1 Cr – ₹5 Cr"
 *   }
 *
 * Zoho requires from_time in "dd-MMM-yyyy HH:mm:ss" 24-hour format, and staff_id.
 */
import { zohoPost } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000841122';
const DEFAULT_CALLBACK_SVC = '279048000000841186';
const DEFAULT_STAFF_ID     = '279048000000288162';
const TIME_ZONE            = 'Asia/Calcutta';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "4:30 PM" -> "16:30:00"
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { track, date, slot, name, email, mobile, corpus } = body;

  console.log('[zoho/book] request:', { track, date, slot, name, email, mobile });

  if (!track || !['instant', 'callback'].includes(track)) {
    return res.status(400).json({ error: 'Invalid track' });
  }
  if (!date || !slot || !name || !email || !mobile) {
    return res.status(400).json({ error: 'Missing required fields (date, slot, name, email, mobile)' });
  }
  if (!/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ error: 'Invalid mobile number' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const time24 = to24Hour(slot);
  if (!time24) {
    return res.status(400).json({ error: `Could not parse slot "${slot}"` });
  }

  const serviceId = track === 'instant'
    ? (process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC)
    : (process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC);

  const staffId = track === 'instant'
    ? (process.env.ZOHO_INSTANT_STAFF_ID || DEFAULT_STAFF_ID)
    : (process.env.ZOHO_CALLBACK_STAFF_ID || DEFAULT_STAFF_ID);

  // Zoho Bookings /appointment is form-encoded with service_id, staff_id,
  // from_time, customer_details (JSON string), plus optional fields.
  const customerDetails = {
    name,
    email,
    phone_number: `+91${mobile}`
  };

  const formBody = {
    service_id: serviceId,
    staff_id: staffId,
    from_time: `${date} ${time24}`,            // e.g. "16-Apr-2026 16:30:00"
    customer_details: JSON.stringify(customerDetails),
    time_zone: TIME_ZONE,
    notes: `Corpus: ${corpus || 'not specified'}`
  };

  console.log('[zoho/book] form body:', formBody);

  try {
    const r = await zohoPost('/bookings/v1/json/appointment', formBody);

    console.log('[zoho/book] response status=', r.status, 'data=', JSON.stringify(r.data).slice(0, 600));

    const rv = r.data?.response?.returnvalue || {};
    // Zoho returns HTTP 200 even for failures — the real status lives in the body.
    const innerStatus = rv.status || r.data?.response?.status;
    const innerMessage = rv.message || '';
    const looksLikeFailure = innerStatus === 'failure' || /mandatory|invalid|error/i.test(innerMessage);

    if (!r.ok || looksLikeFailure) {
      return res.status(r.ok ? 502 : (r.status || 502)).json({
        error: innerMessage || 'Booking failed',
        details: r.data
      });
    }

    return res.status(200).json({
      ok: true,
      booking_id: rv.booking_id || rv.id || null,
      summary_url: rv.summary_url || null,
      raw: rv
    });
  } catch (err) {
    console.error('[zoho/book] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
