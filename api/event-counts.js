/**
 * GET /api/event-counts?key=<EVENT_COUNTS_KEY>&days=<n>
 *
 * Funnel counts per day for the LeadFlow dashboard, read on the server. Returns
 * integers only, never event bodies, so this key can't reveal client details.
 * It has its own key because ZOHO_INFO_KEY also opens /api/events.
 *
 * days defaults to 3, capped at 10. Day keys are UTC, as stored. A day with no
 * data has no entry, so a gap can't be read as a fall.
 */
import { timingSafeEqual } from 'node:crypto';
import { getRedis } from './_redis.js';

const DEFAULT_DAYS = 3;
const MAX_DAYS = 10;
const COUNTED_TYPES = ['otp_sent', 'otp_verified', 'details_submitted', 'slot_picked', 'booking_created', 'gbp_redirected'];

function keyMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function countDay(rows) {
  const counts = Object.fromEntries(COUNTED_TYPES.map(t => [t, 0]));
  const otpNumbers = new Set();
  for (const row of rows) {
    let evt;
    try { evt = typeof row === 'string' ? JSON.parse(row) : row; } catch { continue; }
    if (!evt) continue;
    if (Object.hasOwn(counts, evt.type)) counts[evt.type]++;
    const number = `${evt.country_code || ''}${evt.mobile || ''}`;
    if (evt.type === 'otp_sent' && number) otpNumbers.add(number);
  }
  return { ...counts, unique_otp: otpNumbers.size };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyMatches(req.query.key, (process.env.EVENT_COUNTS_KEY || '').trim())) {
    return res.status(404).json({ error: 'Not found' });
  }

  const asked = parseInt(req.query.days, 10);
  const n = Math.min(asked > 0 ? asked : DEFAULT_DAYS, MAX_DAYS);

  try {
    const redis = getRedis();
    const days = {};
    for (let i = 0; i < n; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const rows = await redis.lrange(`events:${day}`, 0, -1);
      if (rows && rows.length) days[day] = countDay(rows);
    }
    return res.status(200).json({ ok: true, days });
  } catch {
    console.error('[event-counts] read failed');
    return res.status(500).json({ ok: false, error: 'Could not read counts' });
  }
}
