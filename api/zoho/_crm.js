/**
 * Zoho CRM Leads integration — funnel mirroring.
 *
 * Each step of the booking funnel either creates a Lead (first time we see the
 * phone number) or updates the existing one. The frontend fires track-event
 * and the backend mirrors state into CRM so your team sees live drop-off data
 * alongside finished bookings in their existing Zoho CRM workflow.
 *
 * Lead identification:
 *   - We search by Phone (the international number, e.g. +919082469064)
 *   - If found, we update that lead
 *   - If not found, we create a new one
 *
 * Fields written (built-in Zoho CRM Lead module):
 *   - Last_Name      (required by Zoho — we split name or use "Lead")
 *   - First_Name     (if name has more than one token)
 *   - Full_Name      (convenience — may be read-only, Zoho usually derives it)
 *   - Phone          (full international format, used as dedupe key)
 *   - Email
 *   - Lead_Status    (standard picklist — we set "Not Contacted" for captured leads)
 *   - Lead_Source    ("Enrichwise Booking App")
 *   - Description    (funnel history — appended as stages progress)
 *
 * Non-fatal by design: any CRM failure is logged but does NOT break the booking
 * flow. CRM mirroring is advisory — the actual Zoho Bookings appointment still
 * creates even if CRM writes fail.
 */
import { zohoGetJson, zohoPostJson, zohoPutJson } from './_client.js';

const CRM_BASE = '/crm/v6';

// Cache of resolved user email -> Zoho user ID (per Lambda lifetime)
const userIdCache = new Map();

async function resolveUserIdByEmail(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);
  try {
    // Zoho CRM v6 users endpoint — fetch active users and match by email client-side
    const r = await zohoGetJson(`${CRM_BASE}/users`, { type: 'ActiveUsers' });
    if (!r.ok) return null;
    const users = r.data?.users || [];
    const hit = users.find(u => (u.email || '').toLowerCase() === key);
    const id = hit?.id || null;
    userIdCache.set(key, id);
    return id;
  } catch (err) {
    console.warn('[zoho/_crm] user lookup failed for', email, err.message);
    return null;
  }
}

// Map our funnel stages to a human-readable label for the Description log.
const STAGE_LABEL = {
  otp_sent:          'OTP sent',
  otp_verified:      'OTP verified',
  corpus_selected:   'Corpus selected',
  details_submitted: 'Details submitted',
  slot_picked:       'Slot picked',
  booking_created:   'Booking created',
  booking_failed:    'Booking failed',
  gbp_redirected:    'Redirected to GBP form'
};

function splitName(full) {
  const trimmed = (full || '').trim();
  if (!trimmed) return { first: undefined, last: 'Lead' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: undefined, last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export async function findLeadByPhone(mobileDigits) {
  // Search by Mobile field (digits only, no + prefix)
  const criteria = `(Mobile:equals:${mobileDigits})`;
  const r = await zohoGetJson(`${CRM_BASE}/Leads/search`, { criteria });
  if (r.status === 204 || !r.ok) return null;
  const leads = r.data?.data || [];
  return leads[0] || null;
}

/**
 * Upsert a Lead. Called from every funnel step.
 * `info` keys (all optional except mobile + country_code):
 *   stage:      one of STAGE_LABEL keys
 *   mobile, country_code, name, email, corpus, topics, mode, platform,
 *   date, slot, booking_id, note
 */
export async function upsertFunnelLead(info = {}) {
  const { stage, mobile, country_code } = info;
  if (!mobile || !country_code) {
    throw new Error('upsertFunnelLead: mobile and country_code are required');
  }

  // Digits-only international number, e.g. "918793420024" — used as the
  // Mobile field value and for dedup lookup.
  const mobileDigits = `${country_code}${mobile}`.replace(/\D/g, '');
  const stageLabel = STAGE_LABEL[stage] || stage || 'Unknown';
  const logLine = `[${ts()}] ${stageLabel}` + (info.note ? ` — ${info.note}` : '');

  const existing = await findLeadByPhone(mobileDigits);

  // Build the core field set. Only include fields we have data for so we don't
  // overwrite previously-set values with empty strings.
  const fields = {};
  if (info.name) {
    const { first, last } = splitName(info.name);
    if (first) fields.First_Name = first;
    fields.Last_Name = last;
  } else if (!existing) {
    fields.Last_Name = 'Lead';
  }
  // Email handling:
  //   - NEW Lead  → set Email (primary)
  //   - EXISTING Lead → set Secondary_Email, so we don't overwrite the primary
  //     Email the team may already have curated.
  if (info.email) {
    if (existing) fields.Secondary_Email = info.email;
    else          fields.Email = info.email;
  }

  // Store in Mobile field only, digits-only format (e.g. "918793420024")
  fields.Mobile = mobileDigits;

  // Lead_Source written only on create. On update we don't overwrite whatever
  // source the team / other systems have set.
  if (!existing) {
    fields.Lead_Source = 'Enrichwise Booking App';

    // Default owner + RM to Plato for booking-app leads. Configurable via env
    // so we can re-route later without code change. Only set on create so we
    // don't clobber manual reassignments the team has done.
    const defaultOwnerEmail = (process.env.BOOKING_DEFAULT_OWNER_EMAIL || 'pl1.enrichwise@gmail.com').trim();
    const defaultRMEmail    = (process.env.BOOKING_DEFAULT_RM_EMAIL || defaultOwnerEmail).trim();
    const rmFieldName       = (process.env.BOOKING_RM_FIELD || 'RM1').trim();

    if (defaultOwnerEmail) {
      const ownerId = await resolveUserIdByEmail(defaultOwnerEmail);
      if (ownerId) fields.Owner = ownerId;
      else console.warn('[zoho/_crm] could not resolve owner email to user ID:', defaultOwnerEmail);
    }
    if (defaultRMEmail && rmFieldName) {
      // RM1 is a User Lookup field — pass the resolved user ID
      const rmUserId = await resolveUserIdByEmail(defaultRMEmail);
      if (rmUserId) fields[rmFieldName] = rmUserId;
      else console.warn('[zoho/_crm] could not resolve RM email to user ID:', defaultRMEmail);
    }
  }

  // Lead_Status mapping — must match your Zoho CRM Lead_Status picklist values exactly.
  if (stage === 'booking_created') {
    fields.Lead_Status = 'Contacted';
  } else if (!existing) {
    // Only set on create; don't overwrite a team-managed status later
    fields.Lead_Status = 'New Lead';
  }

  // Description log — append new stage to existing log, or start fresh
  const prior = existing?.Description ? String(existing.Description).trim() : '';
  const header = prior ? '' : 'Funnel history:\n';
  fields.Description = (prior ? `${prior}\n${logLine}` : `${header}${logLine}`).slice(-3000); // cap to 3KB

  // Context fields — captured in Description since we can't guarantee custom fields exist
  const ctxParts = [];
  if (info.corpus)         ctxParts.push(`Corpus: ${info.corpus}`);
  if (info.topics)         ctxParts.push(`Topics: ${Array.isArray(info.topics) ? info.topics.join(', ') : info.topics}`);
  if (info.mode)           ctxParts.push(`Mode: ${info.mode}`);
  if (info.platform)       ctxParts.push(`Platform: ${info.platform}`);
  if (info.date && info.slot) ctxParts.push(`Slot: ${info.date} ${info.slot}`);
  if (info.booking_id)     ctxParts.push(`Booking ID: ${info.booking_id}`);
  if (ctxParts.length) {
    fields.Description = `${fields.Description}\n${ctxParts.join(' | ')}`.slice(-3000);
  }

  if (existing) {
    const r = await zohoPutJson(`${CRM_BASE}/Leads/${existing.id}`, {
      data: [fields]
    });
    return { ok: r.ok, action: 'update', id: existing.id, status: r.status, data: r.data };
  } else {
    const r = await zohoPostJson(`${CRM_BASE}/Leads`, {
      data: [fields],
      trigger: []
    });
    const firstResult = r.data?.data?.[0];
    return { ok: r.ok && firstResult?.code === 'SUCCESS', action: 'create', id: firstResult?.details?.id, status: r.status, data: r.data };
  }
}
