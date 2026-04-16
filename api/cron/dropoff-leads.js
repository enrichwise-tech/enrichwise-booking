/**
 * GET /api/cron/dropoff-leads
 *
 * Scheduled endpoint — runs every 8 hours via Vercel Cron.
 * Scans Upstash event logs for people who verified OTP 30+ minutes ago
 * but never completed a booking or GBP redirect. Creates a Zoho CRM Lead
 * for each drop-off so the team can follow up.
 *
 * Dedup: tracks which numbers have already been pushed to CRM via a Redis
 * set `crm:pushed` so the same drop-off doesn't create multiple Leads
 * across cron runs.
 *
 * Protected by CRON_SECRET (Vercel injects this automatically for cron jobs).
 */
import { getRedis } from '../_redis.js';
import { upsertFunnelLead } from '../zoho/_crm.js';

const PUSHED_SET = 'crm:pushed';           // Redis set of "cc:mobile" already pushed
const PUSHED_TTL = 60 * 60 * 24 * 30;      // 30-day retention on the set
const DROPOFF_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

export default async function handler(req, res) {
  setCors(res);

  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  // Manual calls can use ?key=<ZOHO_INFO_KEY> for testing
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryKey = (req.query.key || '').trim();
  const infoKey = (process.env.ZOHO_INFO_KEY || '').trim();

  const isValidCron = cronSecret && authHeader === cronSecret;
  const isValidManual = infoKey && queryKey === infoKey;

  if (!isValidCron && !isValidManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[dropoff-leads] cron started');

  try {
    const redis = getRedis();
    const now = Date.now();
    const cutoff = now - DROPOFF_THRESHOLD_MS;

    // Fetch recent events from the hot list (last 500)
    const raw = await redis.lrange('events:recent', 0, 499);
    const events = (raw || []).map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
    }).filter(Boolean);

    // Group events by full number
    const byNumber = {};
    for (const e of events) {
      if (!e.mobile || !e.country_code) continue;
      const key = `${e.country_code}:${e.mobile}`;
      if (!byNumber[key]) {
        byNumber[key] = {
          mobile: e.mobile,
          country_code: e.country_code,
          stages: new Set(),
          name: '',
          email: '',
          corpus: '',
          topics: '',
          mode: '',
          platform: '',
          first_ts: e.ts || now,
          last_ts: e.ts || now
        };
      }
      const rec = byNumber[key];
      rec.stages.add(e.type);
      if (e.ts && e.ts < rec.first_ts) rec.first_ts = e.ts;
      if (e.ts && e.ts > rec.last_ts) rec.last_ts = e.ts;
      // Capture latest context fields
      if (e.name) rec.name = e.name;
      if (e.email) rec.email = e.email;
      if (e.corpus) rec.corpus = e.corpus;
      if (e.topics) rec.topics = e.topics;
      if (e.mode) rec.mode = e.mode;
      if (e.platform) rec.platform = e.platform;
    }

    // Find drop-offs: verified OTP, 30+ min old, never booked or GBP'd
    const FUNNEL_ORDER = ['otp_sent', 'otp_verified', 'corpus_selected', 'details_submitted', 'slot_picked'];
    const dropoffs = [];

    for (const [key, rec] of Object.entries(byNumber)) {
      // Must have verified OTP
      if (!rec.stages.has('otp_verified')) continue;
      // Must NOT have completed
      if (rec.stages.has('booking_created') || rec.stages.has('gbp_redirected')) continue;
      // Must be old enough (30+ min since last activity)
      if (rec.last_ts > cutoff) continue;

      dropoffs.push({ key, ...rec });
    }

    console.log(`[dropoff-leads] found ${dropoffs.length} drop-offs to process`);

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const results = [];

    for (const d of dropoffs) {
      // Check if already pushed to CRM
      const alreadyPushed = await redis.sismember(PUSHED_SET, d.key);
      if (alreadyPushed) {
        skipped++;
        continue;
      }

      // Determine furthest stage reached
      let furthestStage = 'otp_verified';
      for (const step of FUNNEL_ORDER) {
        if (d.stages.has(step)) furthestStage = step;
      }

      try {
        const result = await upsertFunnelLead({
          stage: furthestStage,
          mobile: d.mobile,
          country_code: d.country_code,
          name: d.name || undefined,
          email: d.email || undefined,
          corpus: d.corpus || undefined,
          topics: d.topics || undefined,
          mode: d.mode || undefined,
          platform: d.platform || undefined,
          note: `Drop-off at "${furthestStage}" — last active ${new Date(d.last_ts).toISOString()}`
        });

        // Mark as pushed so we don't create again next run
        await redis.sadd(PUSHED_SET, d.key);
        await redis.expire(PUSHED_SET, PUSHED_TTL);

        created++;
        results.push({
          number: `+${d.country_code}${d.mobile}`,
          stage: furthestStage,
          action: result.action,
          lead_id: result.id,
          ok: result.ok
        });

        console.log(`[dropoff-leads] ${result.action} lead for +${d.country_code}${d.mobile} at stage "${furthestStage}" → id=${result.id}`);
      } catch (err) {
        failed++;
        console.error(`[dropoff-leads] failed for +${d.country_code}${d.mobile}:`, err.message);
        results.push({
          number: `+${d.country_code}${d.mobile}`,
          stage: furthestStage,
          error: err.message
        });
      }
    }

    console.log(`[dropoff-leads] done: ${created} created, ${skipped} skipped (already pushed), ${failed} failed`);

    return res.status(200).json({
      ok: true,
      total_dropoffs_found: dropoffs.length,
      created,
      skipped,
      failed,
      results
    });
  } catch (err) {
    console.error('[dropoff-leads] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
