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
import { sendAlert } from '../_alert.js';

const DEFAULT_INSTANT_SVC  = '279048000000733018'; // Private consultation (Online)
const DEFAULT_CALLBACK_SVC = '279048000000841186'; // unused
const DEFAULT_STAFF_ID     = '279048000000288162';
const TIME_ZONE            = 'Asia/Calcutta';

// Fallback staff pool if frontend doesn't send staff_ids (shouldn't happen,
// but keeps book working even on an older cached client)
const FALLBACK_STAFF_POOL = [
  '279048000000288162',
  '279048000000371462',
  '279048000000371472',
  '279048000000371482',
  '279048000000655616'
];

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
  const { track, date, slot, name, email, mobile, corpus, topics, mode, platform, staff_ids } = body;
  const countryCode = String(body.country_code || '91').replace(/\D/g, '') || '91';

  console.log('[zoho/book] request:', { track, date, slot, name, email, mobile, country_code: countryCode, topics, mode, platform, staff_ids });

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

  // Staff candidates: prefer whatever the frontend told us were available
  // for this slot (from /api/zoho/slots), fall back to the full pool.
  const candidateStaff = (Array.isArray(staff_ids) && staff_ids.length > 0)
    ? staff_ids
    : FALLBACK_STAFF_POOL;

  // Zoho Bookings /appointment is form-encoded with service_id, staff_id,
  // from_time, customer_details (JSON string), plus optional fields.
  // Zoho Bookings v1 separates built-in fields (customer_details) from
  // service-specific custom fields (additional_fields).
  const topicsArr = Array.isArray(topics) ? topics : (topics ? [topics] : []);

  const customerDetails = {
    name,
    email,
    phone_number: `+${countryCode}${mobile}`
  };

  const additionalFields = {
    "I want to discuss": topicsArr.join(', '),
    "Preferred mode": mode || '',
    "Which platform are you currently using for Investments": platform || ''
  };

  // Try each candidate staff in order. If Zoho says the staff is unavailable
  // (e.g. got booked between slot fetch and book), move on to the next one.
  // Any other failure (validation, auth, custom fields) aborts immediately.
  let lastFailure = null;
  let bookedStaffId = null;
  let rvSuccess = null;

  for (const staffId of candidateStaff) {
    const formBody = {
      service_id: serviceId,
      staff_id: staffId,
      from_time: `${date} ${time24}`,          // e.g. "16-Apr-2026 16:30:00"
      customer_details: JSON.stringify(customerDetails),
      additional_fields: JSON.stringify(additionalFields),
      time_zone: TIME_ZONE,
      notes: `Corpus: ${corpus || 'not specified'}`
    };

    console.log('[zoho/book] trying staff', staffId, 'form body:', formBody);

    let r;
    try {
      r = await zohoPost('/bookings/v1/json/appointment', formBody);
    } catch (err) {
      console.error('[zoho/book] exception for staff', staffId, err.message);
      lastFailure = { status: 500, message: err.message, data: null };
      continue;
    }

    console.log('[zoho/book] staff', staffId, 'response status=', r.status, 'data=', JSON.stringify(r.data).slice(0, 600));

    const rv = r.data?.response?.returnvalue || {};
    const innerStatus = rv.status || r.data?.response?.status;
    const innerMessage = rv.message || '';
    const looksLikeFailure = innerStatus === 'failure' || /mandatory|invalid|error|not available|busy|unavailable/i.test(innerMessage);

    if (r.ok && !looksLikeFailure) {
      bookedStaffId = staffId;
      rvSuccess = rv;
      break;
    }

    lastFailure = { status: r.status, message: innerMessage || 'Booking failed', data: r.data };

    // Only retry with another staff if the failure looks like a staff-availability issue.
    const staffIssue = /not available|busy|unavailable|already booked|staff/i.test(innerMessage);
    if (!staffIssue) {
      console.log('[zoho/book] non-staff failure, aborting retry loop:', innerMessage);
      break;
    }
    console.log('[zoho/book] staff', staffId, 'unavailable, trying next');
  }

  if (!rvSuccess) {
    sendAlert('Booking failed', {
      client: name,
      mobile: `+${countryCode}${mobile}`,
      track,
      date,
      slot,
      zoho_message: lastFailure?.message || '(no message)'
    }).catch(() => {});

    return res.status(lastFailure?.status || 502).json({
      error: lastFailure?.message || 'Booking failed',
      details: lastFailure?.data
    });
  }

  try {
    return res.status(200).json({
      ok: true,
      booking_id: rvSuccess.booking_id || rvSuccess.id || null,
      staff_id: bookedStaffId,
      summary_url: rvSuccess.summary_url || null,
      raw: rvSuccess
    });
  } catch (err) {
    console.error('[zoho/book] error:', err.message);
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
}
