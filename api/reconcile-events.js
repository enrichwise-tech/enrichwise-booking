/**
 * GET /api/reconcile-events
 *
 * Scheduled daily reconciler for the Zoho Bookings -> Zoho CRM Events sync.
 *
 * WHY: The native Zoho Bookings -> Zoho CRM integration ("zohobookingstest"
 *      app) has a history of silent multi-hour outages during which new
 *      Bookings are made but no matching CRM Event is created. On 2026-08-27
 *      the sync stalled from ~15:00 to ~10:42 next-morning IST, dropping 17
 *      confirmed appointments (mostly Sep 13). RMs learned about them only
 *      when a manual count comparison surfaced the gap 5 days later.
 *
 * WHAT: Every day, list every upcoming Zoho Booking and every upcoming CRM
 *       Event, then diff them by Booking ID (which the native sync writes into
 *       the Event Description as "Booking ID : EN-XXXXX"). Any Booking with no
 *       matching Event is drift and gets alerted via Periskope.
 *
 * OPTIONAL BACKFILL: pass ?backfill=1 to auto-create the missing Events. Each
 *       created Event uses trigger:[] so the standard notification workflows
 *       (WATI reminders, "Initial Booking confirmation") do NOT fire twice —
 *       the customer already got their confirmation from the Bookings side.
 *
 * Auth (mirroring dropoff-leads.js):
 *   - CRON_SECRET as Bearer header (used by Vercel Cron)
 *   - ZOHO_INFO_KEY as ?key= query param (manual admin invocation)
 */
import { zohoGet, zohoGetJson, zohoPostJson } from './zoho/_client.js';
import { sendAlert } from './_alert.js';

const CRM_BASE = '/crm/v6';
const BOOKINGS_PATH = '/bookings/v1/json/fetchappointment';
const COQL_PATH = `${CRM_BASE}/coql`;
const TIME_ZONE = 'Asia/Calcutta';

// How many days ahead to reconcile. Zoho Bookings horizon caps at ~18 days for
// the primary Wealth service, so 21 is comfortably beyond it and catches
// anything the horizon exposes today.
const DEFAULT_HORIZON_DAYS = 21;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Local Zoho Bookings staff_email -> CRM user ID map. Populated at cold start
// from the CRM users endpoint. Keeps the reconciler self-contained (no reliance
// on manual mappings that go stale as the sales team turns over).
const staffEmailToCrmUserId = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "2026-09-13" -> "13-Sep-2026" (Zoho Bookings' expected date format)
function toBookingsDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(n => parseInt(n, 10));
  return `${pad2(d)}-${MONTHS[m - 1]}-${y}`;
}

// "2026-09-13" -> "2026-09-13T00:00:00+05:30" (COQL-friendly IST)
function toIsoStartIst(isoDate)  { return `${isoDate}T00:00:00+05:30`; }
function toIsoEndIst(isoDate)    { return `${isoDate}T23:59:59+05:30`; }

// Add n days to a YYYY-MM-DD (using UTC math to avoid DST edge cases)
function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(x => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// Get today's date in IST as YYYY-MM-DD
function istTodayIso() {
  const now = new Date();
  const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000 - (now.getTimezoneOffset() * 60 * 1000);
  const ist = new Date(istMs);
  return `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}`;
}

// Pull every Booking in [fromDate, toDate] paginating page-by-page. Zoho
// Bookings returns 50 per page and only sets next_page_available when more
// exist. The "No Match Found" sentinel means an empty range.
async function fetchAllBookings(fromDate, toDate) {
  const from = `${toBookingsDate(fromDate)} 00:00:00`;
  const to   = `${toBookingsDate(toDate)} 23:59:59`;
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const dataParam = JSON.stringify({ from_time: from, to_time: to, page });
    const r = await zohoGet(BOOKINGS_PATH, { data: dataParam });
    if (!r.ok) throw new Error(`Bookings fetch failed page ${page}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const rv = r.data?.response?.returnvalue || {};
    const resp = rv.response;
    if (typeof resp === 'string') break; // "No Match Found"
    if (!Array.isArray(resp)) break;
    for (const b of resp) out.push(b);
    if (!rv.next_page_available) break;
  }
  return out;
}

// Pull every CRM Event in [fromDate, toDate], extracting the Booking ID from
// the Description. Uses the /Events/search endpoint (not COQL) because the
// booking-app's ZOHO_REFRESH_TOKEN is granted for module scopes only, not for
// coql.READ, and re-minting the refresh token would push out unrelated
// consumers of the same self-client per Zoho's ~20-token FIFO cap.
// per_page maxes at 200; page-loops until more_records is false.
async function fetchAllEventBookingIds(fromDate, toDate) {
  const bidMap = new Map(); // "EN-12345" -> event id (first-seen wins)
  const criteria = `((Start_DateTime:greater_equal:${toIsoStartIst(fromDate)})and(Start_DateTime:less_equal:${toIsoEndIst(toDate)}))`;
  for (let page = 1; page <= 100; page++) {
    const r = await zohoGetJson(`${CRM_BASE}/Events/search`, {
      criteria,
      fields: 'id,Start_DateTime,Description',
      per_page: 200,
      page
    });
    // Empty result set returns 204 No Content
    if (r.status === 204) break;
    if (!r.ok) {
      throw new Error(`Events search failed page ${page}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const rows = r.data?.data || [];
    for (const row of rows) {
      const m = /Booking ID\s*:\s*(EN-\d+)/i.exec(row.Description || '');
      if (m && !bidMap.has(m[1])) bidMap.set(m[1], row.id);
    }
    if (!r.data?.info?.more_records) break;
  }
  return bidMap;
}

// Resolve a staff email to CRM user ID (cached per-invocation).
async function resolveStaffCrmId(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (staffEmailToCrmUserId.has(key)) return staffEmailToCrmUserId.get(key);
  try {
    const r = await zohoGetJson(`${CRM_BASE}/users`, { type: 'ActiveUsers' });
    if (r.ok) {
      const users = r.data?.users || [];
      for (const u of users) {
        if (u.email) staffEmailToCrmUserId.set(u.email.toLowerCase(), u.id);
      }
    }
  } catch (err) {
    console.warn('[reconcile] user lookup failed:', err.message);
  }
  return staffEmailToCrmUserId.get(key) || null;
}

// Find an existing Lead by mobile (digits-only). Falls back to a Contact search
// only if no Lead matches — Bookings clients live overwhelmingly as Leads.
async function findLeadIdByPhone(phoneRaw) {
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (!digits) return null;
  // Try the raw digits and also drop-leading-country-code variants — Zoho
  // Leads' Mobile field is stored digits-only but not consistently formatted.
  const variants = new Set([digits]);
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  if (digits.length === 10) variants.add(`91${digits}`);
  for (const v of variants) {
    try {
      const r = await zohoGetJson(`${CRM_BASE}/Leads/search`, { criteria: `(Mobile:equals:${v})` });
      if (r.status === 204) continue;
      if (!r.ok) continue;
      const rows = r.data?.data || [];
      if (rows[0]?.id) return rows[0].id;
    } catch {
      // keep trying variants
    }
  }
  return null;
}

// Build the Event payload for a Booking. Description mimics the native sync's
// layout so RMs see a familiar record. Add a backfill footer for provenance.
function buildEventPayload(booking, ownerCrmId, whatIdLeadId, reasonNote) {
  // Convert booking iso_start_time (UTC "Z") to +05:30 for CRM (which stores in
  // IST). Bookings returns iso_start_time like "2026-09-13T05:00:00+00:00".
  const toIst = utcIso => {
    if (!utcIso) return null;
    const d = new Date(utcIso);
    const ms = d.getTime() + (5 * 60 + 30) * 60 * 1000;
    const ist = new Date(ms);
    return `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}T${pad2(ist.getUTCHours())}:${pad2(ist.getUTCMinutes())}:${pad2(ist.getUTCSeconds())}+05:30`;
  };
  const descLines = [
    'Customer Info',
    `Name : ${booking.customer_name || ''}`,
    `Email : ${booking.customer_email || ''}`,
    `Contact Number : ${booking.customer_contact_no || ''}`,
    `Booking ID : ${(booking.booking_id || '').replace(/^#/, '')}`,
  ];
  if (booking.notes) descLines.push(`Notes : ${booking.notes}`);
  descLines.push('', 'Service Info', `Service Name : ${booking.service_name || ''}`);
  if (reasonNote) { descLines.push('', `[${reasonNote}]`); }
  const payload = {
    Event_Title: `${booking.service_name || 'Meeting'} with ${booking.customer_name || 'Guest'}`,
    Start_DateTime: toIst(booking.iso_start_time),
    End_DateTime:   toIst(booking.iso_end_time),
    Description: descLines.join('\n')
  };
  if (ownerCrmId) payload.Owner = { id: ownerCrmId };
  if (whatIdLeadId) {
    payload.What_Id = { id: whatIdLeadId };
    payload.$se_module = 'Leads';
  }
  return payload;
}

export default async function handler(req, res) {
  setCors(res);

  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryKey = (req.query.key || '').trim();
  const infoKey = (process.env.ZOHO_INFO_KEY || '').trim();

  const isValidCron   = cronSecret && authHeader === cronSecret;
  const isValidManual = infoKey && queryKey === infoKey;
  if (!isValidCron && !isValidManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Backfill is manual-only (never auto-run from cron) to avoid a runaway
  // creating hundreds of duplicate Events if the diff logic ever misfires.
  const shouldBackfill = isValidManual && req.query.backfill === '1';
  const alertOnDrift   = req.query.alert !== '0'; // on by default

  const todayIso = req.query.from || istTodayIso();
  const horizon  = parseInt(req.query.days || DEFAULT_HORIZON_DAYS, 10) || DEFAULT_HORIZON_DAYS;
  const toIso    = req.query.to || addDays(todayIso, horizon);

  console.log(`[reconcile] range ${todayIso} .. ${toIso} backfill=${shouldBackfill}`);

  try {
    const [bookings, eventBidMap] = await Promise.all([
      fetchAllBookings(todayIso, toIso),
      fetchAllEventBookingIds(todayIso, toIso)
    ]);

    // Cancelled bookings are legitimately absent from CRM (the native sync
    // deletes their Event on cancel), so exclude them from the drift set.
    const upcoming = bookings.filter(b => b.status !== 'cancel');
    const drift = [];
    for (const b of upcoming) {
      const bid = (b.booking_id || '').replace(/^#/, '');
      if (!bid) continue;
      if (!eventBidMap.has(bid)) drift.push(b);
    }

    console.log(`[reconcile] bookings=${bookings.length} upcoming=${upcoming.length} events_with_bid=${eventBidMap.size} drift=${drift.length}`);

    const summary = {
      ok: true,
      range: { from: todayIso, to: toIso, days: horizon },
      bookings_total: bookings.length,
      bookings_upcoming: upcoming.length,
      events_with_booking_id: eventBidMap.size,
      drift_count: drift.length,
      drift: drift.map(b => ({
        booking_id: (b.booking_id || '').replace(/^#/, ''),
        customer: b.customer_name,
        email: b.customer_email,
        phone: b.customer_contact_no,
        staff: b.staff_name,
        start_time: b.start_time,
        service: b.service_name,
        booked_on: b.booked_on
      }))
    };

    if (alertOnDrift && drift.length > 0) {
      // Cap the alert body so we don't blow the Periskope 4KB limit if drift
      // is huge. Show top 10 by appointment time, count the rest.
      const shown = drift.slice(0, 10);
      const rest = drift.length - shown.length;
      const details = {
        range: `${todayIso} to ${toIso}`,
        missing_count: drift.length,
        cases: shown.map(b => `${(b.booking_id||'').replace(/^#/,'')} ${b.start_time} ${b.customer_name} (${b.staff_name})`).join('\n'),
        rest: rest > 0 ? `+${rest} more` : ''
      };
      sendAlert('Booking sync drift', details).catch(() => {});
    }

    if (!shouldBackfill || drift.length === 0) {
      return res.status(200).json(summary);
    }

    // ---- Backfill path ----
    const backfilled = [];
    const failed = [];
    for (const b of drift) {
      try {
        const [ownerCrmId, leadId] = await Promise.all([
          resolveStaffCrmId(b.staff_email),
          findLeadIdByPhone(b.customer_contact_no)
        ]);
        const payload = buildEventPayload(
          b,
          ownerCrmId,
          leadId,
          `Backfilled ${new Date().toISOString().slice(0,10)} by reconciler — Bookings->CRM sync drift for ${(b.booking_id||'').replace(/^#/,'')}`
        );
        const r = await zohoPostJson(`${CRM_BASE}/Events`, { data: [payload], trigger: [] });
        const first = r.data?.data?.[0];
        if (r.ok && first?.code === 'SUCCESS') {
          backfilled.push({ booking_id: (b.booking_id||'').replace(/^#/,''), event_id: first.details?.id, lead_id: leadId, owner_id: ownerCrmId });
        } else {
          failed.push({ booking_id: (b.booking_id||'').replace(/^#/,''), error: first?.message || JSON.stringify(r.data).slice(0, 200) });
        }
      } catch (err) {
        failed.push({ booking_id: (b.booking_id||'').replace(/^#/,''), error: err.message });
      }
    }

    summary.backfilled_count = backfilled.length;
    summary.backfilled = backfilled;
    summary.backfill_failed = failed;
    return res.status(200).json(summary);
  } catch (err) {
    console.error('[reconcile] error:', err.message);
    sendAlert('Reconciler crashed', { error: err.message }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
