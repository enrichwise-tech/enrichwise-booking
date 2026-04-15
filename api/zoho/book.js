/**
 * POST /api/zoho/book
 *
 * Creates an appointment in Zoho Bookings.
 *
 * Body:
 *   {
 *     track: "instant" | "callback",
 *     date:  "16-Apr-2026",   // from /api/zoho/slots
 *     slot:  "10:30 AM",      // from /api/zoho/slots (same format Zoho returned)
 *     name:  "Manish Sharma",
 *     email: "manish@example.com",
 *     mobile:"9876543210",
 *     corpus:"₹1 Cr – ₹5 Cr"  // free-form, goes into additional_fields
 *   }
 */
import { zohoPost } from './_client.js';

const DEFAULT_INSTANT_SVC  = '279048000000841122';
const DEFAULT_CALLBACK_SVC = '279048000000841186';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { track, date, slot, name, email, mobile, corpus } = body;

  console.log('[zoho/book] request:', { track, date, slot, namePresent: !!name, emailPresent: !!email, mobile });

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

  const serviceId = track === 'instant'
    ? (process.env.ZOHO_INSTANT_SERVICE_ID || DEFAULT_INSTANT_SVC)
    : (process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC);

  // Zoho Bookings appointment API expects form-encoded "data" param containing JSON
  const appointmentData = {
    service_id: serviceId,
    from_time: `${date} ${slot}`, // e.g. "16-Apr-2026 10:30 AM"
    customer_details: {
      name,
      email,
      phone_number: `+91${mobile}`
    },
    additional_fields: {
      corpus: corpus || ''
    }
  };

  try {
    const r = await zohoPost('/bookings/v1/json/appointment', {
      data: JSON.stringify(appointmentData)
    });

    console.log('[zoho/book] response status=', r.status, 'data=', JSON.stringify(r.data).slice(0, 500));

    if (!r.ok) {
      return res.status(r.status || 502).json({
        error: 'Booking failed',
        details: r.data
      });
    }

    const booking = r.data?.response?.returnvalue || {};
    return res.status(200).json({
      ok: true,
      booking_id: booking.booking_id || booking.id || null,
      summary: booking.summary_url || null,
      raw: booking
    });
  } catch (err) {
    console.error('[zoho/book] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
