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
 * No staff_id is sent. Zoho auto-assigns a free staff from the service's
 * pool — verified 2026-04-24 via /api/zoho/test-book-no-staff. This avoids
 * the per-staff retry loop that previously masked the real error when all
 * staff in our local pool happened to mismatch Zoho's actual schedule.
 *
 * Zoho requires from_time in "dd-MMM-yyyy HH:mm:ss" 24-hour format.
 */
import { zohoPost } from './_client.js';
import { sendAlert } from '../_alert.js';

const DEFAULT_INSTANT_SVC  = '279048000000733018'; // Private consultation (Online)
const DEFAULT_CALLBACK_SVC = '279048000000841186'; // unused
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
  const { track, date, slot, name, email, mobile, corpus, topics, mode, platform, query } = body;
  const countryCode = String(body.country_code || '91').replace(/\D/g, '') || '91';

  console.log('[zoho/book] request:', { track, date, slot, name, email, mobile, country_code: countryCode, topics, mode, platform, queryPresent: !!query });

  if (!track || !['instant', 'callback'].includes(track)) {
    return res.status(400).json({ error: 'Invalid track' });
  }
  if (!date || !slot || !name || !email || !mobile) {
    return res.status(400).json({ error: 'Missing required fields (date, slot, name, email, mobile)' });
  }
  if (!/^\d{6,15}$/.test(String(mobile))) {
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

  const topicsArr = Array.isArray(topics) ? topics : (topics ? [topics] : []);

  const customerDetails = {
    name,
    email,
    phone_number: `+${countryCode}${mobile}`
  };

  const additionalFields = {
    'I want to discuss': topicsArr.join(', '),
    'Preferred mode': mode || '',
    'Which platform are you currently using for Investments': platform || ''
  };
  if (query && String(query).trim()) {
    additionalFields['Please describe your query in brief'] = String(query).trim();
  }

  const formBody = {
    service_id: serviceId,
    from_time: `${date} ${time24}`,
    customer_details: JSON.stringify(customerDetails),
    additional_fields: JSON.stringify(additionalFields),
    time_zone: TIME_ZONE,
    notes: `Corpus: ${corpus || 'not specified'}`
  };

  console.log('[zoho/book] posting (no staff_id, Zoho auto-assigns):', formBody);

  let r;
  try {
    r = await zohoPost('/bookings/v1/json/appointment', formBody);
  } catch (err) {
    console.error('[zoho/book] exception:', err.message);
    sendAlert('Booking crashed', {
      client: name,
      mobile: `+${countryCode}${mobile}`,
      track,
      date,
      slot,
      error: err.message
    }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }

  console.log('[zoho/book] response status=', r.status, 'data=', JSON.stringify(r.data).slice(0, 600));

  const rv = r.data?.response?.returnvalue || {};
  const innerStatus = rv.status || r.data?.response?.status;
  const innerMessage = rv.message || '';
  const looksLikeFailure = innerStatus === 'failure' || /mandatory|invalid|error|not available|busy|unavailable/i.test(innerMessage);

  if (!r.ok || looksLikeFailure) {
    sendAlert('Booking failed', {
      client: name,
      mobile: `+${countryCode}${mobile}`,
      track,
      date,
      slot,
      zoho_message: innerMessage || '(no message)'
    }).catch(() => {});

    return res.status(r.status || 502).json({
      error: innerMessage || 'Booking failed',
      details: r.data
    });
  }

  return res.status(200).json({
    ok: true,
    booking_id: rv.booking_id || rv.id || null,
    staff_id: rv.staff_id || null,
    staff_name: rv.staff_name || null,
    summary_url: rv.summary_url || null,
    raw: rv
  });
}
