/**
 * GET /api/dropoff-leads
 *
 * Scheduled endpoint — runs daily via Vercel Cron (and manually callable with
 * ?key=<ZOHO_INFO_KEY>). Creates Zoho CRM Leads for people who verified OTP
 * 30+ minutes ago but never completed booking or GBP redirect.
 *
 * Reads per-number funnel hashes from Redis (via the `funnel:all` index set)
 * instead of the capped 500-event recent buffer — so no drop-off is ever
 * missed regardless of site traffic volume.
 *
 * Dedup: tracks pushed numbers in the `crm:pushed` set (30-day TTL) so the
 * same person never creates a duplicate CRM Lead across runs.
 */
import { getRedis } from './_redis.js';
import { upsertFunnelLead } from './zoho/_crm.js';

const PUSHED_SET = 'crm:pushed';
const PUSHED_TTL = 60 * 60 * 24 * 30;      // 30 days
const DROPOFF_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

const FUNNEL_ORDER = ['otp_sent', 'otp_verified', 'corpus_selected', 'details_submitted', 'slot_picked', 'booking_created'];
const DROP_STAGES  = new Set(['otp_verified', 'corpus_selected', 'details_submitted', 'slot_picked']);
const DONE_STAGES  = new Set(['booking_created', 'gbp_redirected']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

export default async function handler(req, res) {
  setCors(res);

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

    // 1. Enumerate every phone number we've seen (persistent index)
    const allNumbers = (await redis.smembers('funnel:all')) || [];
    console.log(`[dropoff-leads] scanning ${allNumbers.length} funnel numbers`);

    // 2. For each, read the per-number hash (latest stage + context)
    const dropoffs = [];
    for (const fullNum of allNumbers) {
      const hash = await redis.hgetall(`funnel:${fullNum}`);
      if (!hash || !hash.last_stage) continue;

      // Must have at least verified OTP
      if (!DROP_STAGES.has(hash.last_stage)) continue;

      // Must NOT have completed (already covered by hash.last_stage check above,
      // but we keep this guard in case new done-stages are added later)
      if (DONE_STAGES.has(hash.last_stage)) continue;

      const lastTs = parseInt(hash.last_ts || '0', 10);
      if (!lastTs || lastTs > cutoff) continue; // too recent

      dropoffs.push({
        fullNum,
        mobile: hash.mobile || '',
        country_code: hash.country_code || '',
        last_stage: hash.last_stage,
        last_ts: lastTs,
        name: hash.name || '',
        email: hash.email || '',
        corpus: hash.corpus || '',
        topics: hash.topics || '',
        mode: hash.mode || '',
        platform: hash.platform || ''
      });
    }

    console.log(`[dropoff-leads] found ${dropoffs.length} eligible drop-offs`);

    let created = 0, skipped = 0, failed = 0;
    const results = [];

    for (const d of dropoffs) {
      // Skip if already pushed to CRM in a previous run
      const alreadyPushed = await redis.sismember(PUSHED_SET, d.fullNum);
      if (alreadyPushed) { skipped++; continue; }

      if (!d.country_code || !d.mobile) { skipped++; continue; }

      try {
        const result = await upsertFunnelLead({
          stage: d.last_stage,
          mobile: d.mobile,
          country_code: d.country_code,
          name: d.name || undefined,
          email: d.email || undefined,
          corpus: d.corpus || undefined,
          topics: d.topics || undefined,
          mode: d.mode || undefined,
          platform: d.platform || undefined,
          note: `Drop-off at "${d.last_stage}" — last active ${new Date(d.last_ts).toISOString()}`
        });

        await redis.sadd(PUSHED_SET, d.fullNum);
        await redis.expire(PUSHED_SET, PUSHED_TTL);

        created++;
        results.push({
          number: `+${d.country_code}${d.mobile}`,
          stage: d.last_stage,
          last_active: new Date(d.last_ts).toISOString(),
          action: result.action,
          lead_id: result.id,
          ok: result.ok
        });

        console.log(`[dropoff-leads] ${result.action} lead for +${d.country_code}${d.mobile} at "${d.last_stage}" -> ${result.id}`);
      } catch (err) {
        failed++;
        console.error(`[dropoff-leads] failed for +${d.country_code}${d.mobile}:`, err.message);
        results.push({
          number: `+${d.country_code}${d.mobile}`,
          stage: d.last_stage,
          error: err.message
        });
      }
    }

    console.log(`[dropoff-leads] done: ${created} created, ${skipped} skipped, ${failed} failed`);

    return res.status(200).json({
      ok: true,
      scanned: allNumbers.length,
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
