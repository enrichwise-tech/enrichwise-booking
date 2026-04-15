/**
 * GET /api/events?key=<ZOHO_INFO_KEY>&limit=200
 *
 * Protected endpoint — returns the most recent funnel events plus a rolled-up
 * drop-off report so you can see who started but didn't finish.
 *
 * Gated behind the same query-key as /api/zoho/info to avoid leaking traffic.
 */
import { getRecentEvents } from './_events.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = (process.env.ZOHO_INFO_KEY || '').trim();
  const provided = (req.query.key || '').trim();
  if (!expected || provided !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);

  try {
    const events = await getRecentEvents(limit);

    // Roll up into per-number funnel state
    const byNumber = {};
    for (const e of events) {
      if (!e.mobile) continue;
      const k = `${e.country_code || ''}${e.mobile}`;
      if (!byNumber[k]) {
        byNumber[k] = {
          mobile: e.mobile,
          country_code: e.country_code,
          first_ts: e.ts,
          last_ts: e.ts,
          stages: []
        };
      }
      const rec = byNumber[k];
      rec.stages.push({ type: e.type, ts: e.ts });
      if (e.ts < rec.first_ts) rec.first_ts = e.ts;
      if (e.ts > rec.last_ts) rec.last_ts = e.ts;
    }

    // Compute drop-off buckets
    const FUNNEL_ORDER = [
      'otp_sent',
      'otp_verified',
      'corpus_selected',
      'details_submitted',
      'slot_picked',
      'booking_created'
    ];
    const counts = {};
    for (const step of FUNNEL_ORDER) counts[step] = 0;
    for (const e of events) {
      if (counts[e.type] !== undefined) counts[e.type] += 1;
    }

    // Drop-offs: started funnel but never hit "booking_created" or "gbp_redirected"
    const dropoffs = [];
    for (const rec of Object.values(byNumber)) {
      const types = new Set(rec.stages.map(s => s.type));
      const booked = types.has('booking_created');
      const gbp = types.has('gbp_redirected');
      if (!booked && !gbp) {
        // Find the furthest stage reached
        let furthest = 'otp_sent';
        for (const step of FUNNEL_ORDER) {
          if (types.has(step)) furthest = step;
        }
        dropoffs.push({
          mobile: `+${rec.country_code}${rec.mobile}`,
          last_stage: furthest,
          last_ts: new Date(rec.last_ts).toISOString()
        });
      }
    }
    dropoffs.sort((a, b) => new Date(b.last_ts) - new Date(a.last_ts));

    return res.status(200).json({
      ok: true,
      total_events: events.length,
      funnel_counts: counts,
      dropoffs_count: dropoffs.length,
      dropoffs: dropoffs.slice(0, 100),
      events: events.slice(0, Math.min(100, limit))
    });
  } catch (err) {
    console.error('[events] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
