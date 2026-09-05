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
import { getRedis } from '../_redis.js';

const DEFAULT_INSTANT_SVC   = '279048000000733018'; // Private consultation (Online) — 6 staff
const DEFAULT_PRIORITY_SVC  = '279048000001524162'; // Priority Diagnostic Call — 2 staff, 3-day rolling
// The Zoho service IDs the app is allowed to route bookings to. Frontend picks
// which one per slot (tagged in slots.js) and passes service_id in the POST.
// Anything not in this allowlist falls back to the default instant service.
function getAllowedServiceIds() {
  return [
    (process.env.ZOHO_INSTANT_SERVICE_ID  || DEFAULT_INSTANT_SVC ).trim(),
    (process.env.ZOHO_PRIORITY_SERVICE_ID || DEFAULT_PRIORITY_SVC).trim(),
    (process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC).trim()
  ].filter(Boolean);
}
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
  const requestedServiceId = body.service_id ? String(body.service_id).trim() : '';
  const countryCode = String(body.country_code || '91').replace(/\D/g, '') || '91';

  console.log('[zoho/book] request:', { track, date, slot, name, email, mobile, country_code: countryCode, topics, mode, platform, queryPresent: !!query, requestedServiceId, bodyKeys: Object.keys(body) });

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

  // Build the list of services to try, in order:
  //  1. The service_id the frontend tagged onto this slot (if valid)
  //  2. The track's default (Wealth for instant, Callback for callback)
  //  3. Every other known instant-track service (so a stale browser cache
  //     that sends no service_id still lands on the RIGHT one — the Priority
  //     Diagnostic slots would otherwise get routed to Wealth and rejected
  //     as "Slot Not Available")
  const allowed = getAllowedServiceIds();
  const trackDefault = track === 'instant'
    ? (process.env.ZOHO_INSTANT_SERVICE_ID  || DEFAULT_INSTANT_SVC)
    : (process.env.ZOHO_CALLBACK_SERVICE_ID || DEFAULT_CALLBACK_SVC);
  const candidateServices = [];
  const push = sid => { if (sid && !candidateServices.includes(sid)) candidateServices.push(sid); };
  if (requestedServiceId && allowed.includes(requestedServiceId)) push(requestedServiceId);
  push(trackDefault);
  if (track === 'instant') {
    // include the other instant-track service as a fallback
    push((process.env.ZOHO_PRIORITY_SERVICE_ID || DEFAULT_PRIORITY_SVC).trim());
    push((process.env.ZOHO_INSTANT_SERVICE_ID  || DEFAULT_INSTANT_SVC ).trim());
  }
  const serviceId = candidateServices[0]; // primary attempt; we'll try others on Slot Not Available

  const topicsArr = Array.isArray(topics) ? topics : (topics ? [topics] : []);

  const customerDetails = {
    name,
    email,
    phone_number: `+${countryCode}${mobile}`
  };

  // Defensive truncation — Zoho's custom text fields have character caps and
  // reject the whole booking when exceeded ("Character limit exceeded"). The
  // platform field's real Zoho cap is below 100 (observed rejection from a
  // 100-char-capped value on 2026-06-18), so we drop to 50 — comfortably
  // under any reasonable field config and still enough for "Zerodha, ICICI
  // Direct, Groww" style answers.
  const truncate = (v, n) => String(v || '').trim().slice(0, n);

  const additionalFields = {
    'I want to discuss': topicsArr.join(', '),
    'Preferred mode': mode || '',
    'Which platform are you currently using for Investments': truncate(platform, 50)
  };
  if (query && String(query).trim()) {
    additionalFields['Please describe your query in brief'] = truncate(query, 500);
  }

  const formBodyBase = {
    from_time: `${date} ${time24}`,
    customer_details: JSON.stringify(customerDetails),
    additional_fields: JSON.stringify(additionalFields),
    time_zone: TIME_ZONE,
    notes: `Corpus: ${corpus || 'not specified'}`
  };

  // Try each candidate service in order. Zoho rejects with "Slot Not
  // Available" if the specific service doesn't offer this exact slot time —
  // so if the primary fails that way, we retry against the other known
  // instant-track service before giving up. This makes the flow resilient
  // to stale frontend caches that didn't tag the slot with service_id.
  let r = null;
  let usedServiceId = null;
  let lastInnerMessage = '';
  let lastData = null;
  for (const sid of candidateServices) {
    usedServiceId = sid;
    const formBody = { ...formBodyBase, service_id: sid };
    console.log('[zoho/book] attempting service', sid, formBody);
    try {
      r = await zohoPost('/bookings/v1/json/appointment', formBody);
    } catch (err) {
      console.error('[zoho/book] exception on', sid, ':', err.message);
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

    console.log('[zoho/book] response for', sid, 'status=', r.status, 'data=', JSON.stringify(r.data).slice(0, 600));

    const rv = r.data?.response?.returnvalue || {};
    const innerStatus = rv.status || r.data?.response?.status;
    const innerMessage = rv.message || '';
    lastInnerMessage = innerMessage;
    lastData = r.data;
    const looksLikeFailure = innerStatus === 'failure' || /mandatory|invalid|error|not available|busy|unavailable/i.test(innerMessage);

    if (r.ok && !looksLikeFailure) {
      // Success — bust the Redis slot cache for THIS date across ALL known
      // services so the next customer viewing the calendar sees fresh
      // availability, not a stale up-to-30s snapshot that still shows this
      // slot as free. Fire-and-forget — cache bust failure never blocks
      // returning success to the customer.
      try {
        const redis = getRedis();
        const dels = allowed.map(id => redis.del(`zoho:slots:${id}:${date}`));
        Promise.all(dels).catch(() => {});
      } catch {}

      // Success — populate response with what actually landed
      return res.status(200).json({
        ok: true,
        booking_id: rv.booking_id || rv.id || null,
        staff_id: rv.staff_id || null,
        staff_name: rv.staff_name || null,
        summary_url: rv.summary_url || null,
        service_id: sid,
        raw: rv
      });
    }
    // On "Slot Not Available" / "not available" style errors, try the next
    // service. On other errors (mandatory field, invalid, etc.), fail fast.
    const shouldRetry = /not available|busy|unavailable/i.test(innerMessage);
    if (!shouldRetry) break;
    console.log('[zoho/book] slot not available on', sid, '— trying next candidate');
  }

  // Exhausted all candidates OR hit a non-retryable error
  sendAlert('Booking failed', {
    client: name,
    mobile: `+${countryCode}${mobile}`,
    track,
    date,
    slot,
    zoho_message: lastInnerMessage || '(no message)'
  }).catch(() => {});

  return res.status(r?.status || 502).json({
    error: lastInnerMessage || 'Booking failed',
    // Debug context — helps diagnose routing bugs from the browser.
    debug: {
      service_id_requested: requestedServiceId || null,
      services_tried: candidateServices,
      last_service_tried: usedServiceId,
      allowed: allowed
    },
    details: lastData
  });
}
