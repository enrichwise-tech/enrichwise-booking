/**
 * Dates closed to new bookings on the website, in Zoho's "DD-Mon-YYYY" format.
 *
 * Use this when Zoho refuses a full-day Unavailability override because the
 * date already has appointments. slots.js shows these dates as having no
 * slots, and book.js rejects bookings for them without calling Zoho.
 * Existing Zoho appointments on these dates are not touched.
 *
 * Zoho's own booking page (enrichwise.zohobookings.in) is NOT covered.
 */
export const BLOCKED_DATES = new Set([
  '10-Nov-2026', // closed 26-Oct-2026 at user's request; 5 bookings already exist
]);

export function isBlockedDate(dateStr) {
  return BLOCKED_DATES.has(String(dateStr || '').trim());
}
