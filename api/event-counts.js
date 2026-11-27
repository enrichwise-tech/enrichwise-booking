/**
 * GET /api/event-counts?key=<EVENT_COUNTS_KEY>&days=<n>
 * GET /api/event-counts?key=<EVENT_COUNTS_KEY>&days=<n>&by=corpus
 *
 * Funnel counts per day for the LeadFlow dashboard, read on the server. Returns
 * integers and fixed corpus labels only, never event bodies, so this key can't
 * reveal client details. It has its own key because ZOHO_INFO_KEY also opens
 * /api/events.
 *
 * Default mode: raw event counts per UTC day. days defaults to 3, capped at 10.
 *
 * by=corpus: distinct people per day, how far each got, split by the amount
 * option they picked. days defaults to 14, capped at 60 (the log keeps 60).
 *   - A person is a country code + mobile.
 *   - A person belongs to the UTC day of their FIRST otp_sent in the window,
 *     even if they carried on the next day. People whose first otp_sent falls
 *     before the window are left out, so a day is never half-counted.
 *   - Their corpus is the last label they picked. Labels the page has never
 *     sent are counted as "other", so nothing typed into the log can leak out.
 *     People who never reached the amount step are under "none".
 *   - reached[step]: people who got at least that far (furthest step at or
 *     past it). gbp_redirected is a side branch, counted on its own.
 *   - furthest[step]: people whose furthest step was exactly that one.
 *
 * Day keys are UTC, as stored. A day with no data has no entry, so a gap can't
 * be read as a fall.
 */
import { timingSafeEqual } from 'node:crypto';
import { getRedis } from './_redis.js';

const DEFAULT_DAYS = 3;
const MAX_DAYS = 10;
const CORPUS_DEFAULT_DAYS = 14;
const CORPUS_MAX_DAYS = 60;
const COUNTED_TYPES = ['otp_sent', 'otp_verified', 'details_submitted', 'slot_picked', 'booking_created', 'gbp_redirected'];

// The main path, in order. gbp_redirected branches off after corpus_selected.
const STEPS = ['otp_sent', 'otp_verified', 'corpus_selected', 'details_submitted', 'slot_picked', 'booking_created'];
const RANK = Object.fromEntries(STEPS.map((s, i) => [s, i]));

// Every label the page has sent within the log's 60 days. Anything else is
// "other". "Under ₹1 Cr" stopped on 27-Nov-26, when it was split in two.
export const KNOWN_CORPUS = [
  'Under ₹50 lakh',
  '₹50 lakh – ₹1 Cr',
  'Under ₹1 Cr',
  '₹1 Cr – ₹5 Cr',
  '₹5 Cr+',
  'Goal-based plan client'
];
const KNOWN = new Set(KNOWN_CORPUS);

function keyMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function parseRow(row) {
  try { return typeof row === 'string' ? JSON.parse(row) : row; } catch { return null; }
}

function countDay(rows) {
  const counts = Object.fromEntries(COUNTED_TYPES.map(t => [t, 0]));
  const otpNumbers = new Set();
  for (const row of rows) {
    const evt = parseRow(row);
    if (!evt) continue;
    if (Object.hasOwn(counts, evt.type)) counts[evt.type]++;
    const number = `${evt.country_code || ''}${evt.mobile || ''}`;
    if (evt.type === 'otp_sent' && number) otpNumbers.add(number);
  }
  return { ...counts, unique_otp: otpNumbers.size };
}

function emptyBucket() {
  return {
    people: 0,
    reached: Object.fromEntries([...STEPS, 'gbp_redirected'].map(s => [s, 0])),
    furthest: Object.fromEntries(STEPS.map(s => [s, 0]))
  };
}

function addPerson(bucket, p) {
  bucket.people++;
  for (const s of STEPS) if (p.furthest >= RANK[s]) bucket.reached[s]++;
  if (p.gbp) bucket.reached.gbp_redirected++;
  bucket.furthest[STEPS[p.furthest]]++;
}

/**
 * Pure: events in, counts out. Makes no calls. Exported for the tests.
 */
export function countByCorpus(events) {
  const people = new Map();
  const sorted = events
    .filter(e => e && e.mobile && (RANK[e.type] !== undefined || e.type === 'gbp_redirected'))
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  for (const e of sorted) {
    const id = `${String(e.country_code || '').replace(/\D/g, '')}${String(e.mobile).replace(/\D/g, '')}`;
    if (!id) continue;
    let p = people.get(id);
    if (!p) {
      // Only people who start inside the window are counted.
      if (e.type !== 'otp_sent') continue;
      p = { day: new Date(Number(e.ts)).toISOString().slice(0, 10), furthest: 0, gbp: false, corpus: '' };
      people.set(id, p);
    }
    if (e.type === 'gbp_redirected') p.gbp = true;
    else if (RANK[e.type] > p.furthest) p.furthest = RANK[e.type];
    const label = String(e.corpus || '').trim();
    if (label) p.corpus = label;
  }

  const days = {};
  for (const p of people.values()) {
    const corpus = !p.corpus ? 'none' : (KNOWN.has(p.corpus) ? p.corpus : 'other');
    const d = (days[p.day] ||= { all: emptyBucket(), by_corpus: {} });
    addPerson(d.all, p);
    addPerson((d.by_corpus[corpus] ||= emptyBucket()), p);
  }
  return days;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyMatches(req.query.key, (process.env.EVENT_COUNTS_KEY || '').trim())) {
    return res.status(404).json({ error: 'Not found' });
  }

  const byCorpus = req.query.by === 'corpus';
  const asked = parseInt(req.query.days, 10);
  const n = byCorpus
    ? Math.min(asked > 0 ? asked : CORPUS_DEFAULT_DAYS, CORPUS_MAX_DAYS)
    : Math.min(asked > 0 ? asked : DEFAULT_DAYS, MAX_DAYS);

  try {
    const redis = getRedis();
    const dayKeys = [];
    for (let i = 0; i < n; i++) dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));

    if (!byCorpus) {
      const days = {};
      for (const day of dayKeys) {
        const rows = await redis.lrange(`events:${day}`, 0, -1);
        if (rows && rows.length) days[day] = countDay(rows);
      }
      return res.status(200).json({ ok: true, days });
    }

    const events = [];
    for (const day of dayKeys) {
      const rows = await redis.lrange(`events:${day}`, 0, -1);
      for (const row of rows || []) {
        const evt = parseRow(row);
        if (evt) events.push(evt);
      }
    }
    return res.status(200).json({
      ok: true,
      by: 'corpus',
      window_days: n,
      steps: STEPS,
      labels: KNOWN_CORPUS,
      days: countByCorpus(events)
    });
  } catch {
    console.error('[event-counts] read failed');
    return res.status(500).json({ ok: false, error: 'Could not read counts' });
  }
}
