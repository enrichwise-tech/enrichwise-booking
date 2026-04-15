/**
 * POST /api/track-event
 *
 * Frontend-fired funnel events. No authentication — it's a pure write endpoint
 * that appends to Upstash Redis. Validates basic shape to prevent garbage.
 *
 * Body:
 *   {
 *     type: "otp_sent" | "otp_verified" | "corpus_selected" | "details_submitted"
 *         | "slot_picked" | "booking_created" | "gbp_redirected",
 *     mobile: "9082469064",
 *     country_code: "91",
 *     track: "instant" | "gbp" | "",
 *     ...extra fields...
 *   }
 */
import { logEvent } from './_events.js';
import { upsertFunnelLead } from './zoho/_crm.js';

const ALLOWED_TYPES = new Set([
  'otp_sent',
  'otp_verified',
  'corpus_selected',
  'details_submitted',
  'slot_picked',
  'booking_created',
  'gbp_redirected',
  'booking_failed'
]);

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
  const type = String(body.type || '').trim();

  if (!ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: 'Invalid or missing event type' });
  }

  // Minimal shape validation — mobile is optional but if present must look sane
  const mobile = body.mobile ? String(body.mobile).replace(/\D/g, '') : '';
  const cc = body.country_code ? String(body.country_code).replace(/\D/g, '') : '';
  if (mobile && !/^\d{6,15}$/.test(mobile)) {
    return res.status(400).json({ error: 'Invalid mobile' });
  }
  if (cc && !/^\d{1,4}$/.test(cc)) {
    return res.status(400).json({ error: 'Invalid country_code' });
  }

  const evt = {
    type,
    mobile,
    country_code: cc,
    track: body.track || '',
    corpus: body.corpus || undefined,
    topics: body.topics || undefined,
    mode: body.mode || undefined,
    date: body.date || undefined,
    slot: body.slot || undefined,
    booking_id: body.booking_id || undefined,
    ts: body.ts || Date.now()
  };

  try {
    await logEvent(evt);
  } catch (err) {
    console.error('[track-event] log error:', err.message);
    // Continue — event logging failure shouldn't break CRM mirroring
  }

  // Mirror to Zoho CRM (non-fatal). Skip for types that don't need a CRM touch.
  const CRM_STAGES = new Set([
    'otp_verified', 'corpus_selected', 'details_submitted',
    'slot_picked', 'booking_created', 'gbp_redirected'
  ]);
  if (mobile && CRM_STAGES.has(type)) {
    upsertFunnelLead({
      stage: type,
      mobile,
      country_code: cc,
      name: body.name,
      email: body.email,
      corpus: body.corpus,
      topics: body.topics,
      mode: body.mode,
      platform: body.platform,
      date: body.date,
      slot: body.slot,
      booking_id: body.booking_id
    }).catch((err) => {
      console.error('[track-event] CRM upsert error:', err.message);
    });
  }

  return res.status(200).json({ ok: true });
}
