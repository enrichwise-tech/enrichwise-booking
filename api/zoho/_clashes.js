/**
 * Finds people holding more than one upcoming consultation, and cancels the
 * ones nobody could possibly attend.
 *
 * WHY: Zoho's "Slots per Customer" limit only applies on its own booking
 * page, so duplicates built up through the site's API. The booking page now
 * stops new ones (see _dupes.js), but bookings made on Zoho's page, by the
 * team, or before that went live still need catching.
 *
 * WHAT COUNTS AS A CLASH: two live bookings for the same mobile at exactly
 * the same start time. Nobody can be in two consultations at once, so the
 * later-booked one is always waste and is safe to cancel on its own.
 *
 * WHAT IS ONLY REPORTED: two bookings on the same day at different times.
 * Those can be deliberate (a client who genuinely wants two, or back-to-back
 * meetings), so they go to the team to judge instead of being cancelled.
 * Bookings on different days are left alone entirely.
 *
 * Cancelling is OFF unless explicitly asked for, and capped, because Zoho
 * sends the customer its own cancellation email and WhatsApp with no way to
 * suppress them: a wrong cancel reaches a real client straight away.
 */
import { zohoPost } from './_client.js';

const MAX_CANCELS_PER_RUN = 5; // a bigger pile means something is wrong: report, cancel nothing

function mobileDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d : '';
}

const bid = b => String(b.booking_id || '').replace(/^#/, '');

/**
 * Sort live bookings into clashes (same mobile, same start time) and
 * same-day pairs. Pure: makes no calls and changes nothing.
 */
export function findClashes(bookings) {
  const byMobile = new Map();
  for (const b of bookings || []) {
    if (/cancel|noshow|no_show/i.test(b.status || '')) continue;
    const digits = mobileDigits(b.customer_contact_no);
    if (!digits || !b.start_time) continue;
    if (!byMobile.has(digits)) byMobile.set(digits, []);
    byMobile.get(digits).push(b);
  }

  const clashes = [];   // safe to cancel: same mobile, same exact start time
  const sameDay = [];   // for the team to judge

  for (const [digits, list] of byMobile) {
    if (list.length < 2) continue;
    // Earliest booked first, so the one the customer made first is the keeper.
    const sorted = [...list].sort((a, b) => String(a.booked_on || '').localeCompare(String(b.booked_on || '')));

    const byStart = new Map();
    for (const b of sorted) {
      if (!byStart.has(b.start_time)) byStart.set(b.start_time, []);
      byStart.get(b.start_time).push(b);
    }
    for (const [start, group] of byStart) {
      if (group.length < 2) continue;
      const keep = group[0];
      for (const extra of group.slice(1)) {
        clashes.push({
          mobile: digits,
          customer: extra.customer_name || '',
          start_time: start,
          keep: { booking_id: bid(keep), staff: keep.staff_name || '', booked_on: keep.booked_on || '' },
          cancel: { booking_id: bid(extra), staff: extra.staff_name || '', booked_on: extra.booked_on || '' }
        });
      }
    }

    // Same day, different times: report only.
    const days = new Map();
    for (const b of sorted) {
      const day = String(b.start_time).slice(0, 11);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(b);
    }
    for (const [day, group] of days) {
      const times = new Set(group.map(b => b.start_time));
      if (group.length < 2 || times.size < 2) continue;
      sameDay.push({
        mobile: digits,
        customer: group[0].customer_name || '',
        day,
        bookings: group.map(b => ({ booking_id: bid(b), start_time: b.start_time, staff: b.staff_name || '' }))
      });
    }
  }
  return { clashes, sameDay };
}

/**
 * Cancel one booking in Zoho. The customer is notified by Zoho; there is no
 * way to turn that off, so only ever call this for a genuine clash.
 */
export async function cancelBooking(bookingId) {
  const id = `#${String(bookingId).replace(/^#/, '')}`;
  const r = await zohoPost('/bookings/v1/json/updateappointment', { booking_id: id, action: 'cancel' });
  const outer = r.data?.response?.status;
  const rv = r.data?.response?.returnvalue || {};
  const ok = r.ok && (outer === 'success' || rv.status === 'success');
  return { ok, booking_id: id, message: rv.message || r.data?.response?.message || '', status: r.status };
}

/**
 * Cancel the clashes. Refuses to touch anything if there are more than
 * MAX_CANCELS_PER_RUN of them, since that means the detection, not the
 * diary, is what changed.
 */
export async function cancelClashes(clashes, { apply = false } = {}) {
  if (!apply) return { applied: false, cancelled: [], failed: [], skipped: clashes.length };
  if (clashes.length > MAX_CANCELS_PER_RUN) {
    return { applied: false, cancelled: [], failed: [], skipped: clashes.length, refused: `more than ${MAX_CANCELS_PER_RUN} in one run` };
  }
  const cancelled = [];
  const failed = [];
  for (const c of clashes) {
    try {
      const r = await cancelBooking(c.cancel.booking_id);
      if (r.ok) cancelled.push({ ...c.cancel, customer: c.customer, start_time: c.start_time });
      else failed.push({ ...c.cancel, error: r.message || `status ${r.status}` });
    } catch (err) {
      failed.push({ ...c.cancel, error: err.message });
    }
  }
  return { applied: true, cancelled, failed, skipped: 0 };
}
