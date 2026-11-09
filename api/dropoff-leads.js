/**
 * GET /api/dropoff-leads
 *
 * Scheduled endpoint — runs daily via Vercel Cron (and manually callable with
 * ?key=<ZOHO_INFO_KEY>). Creates / updates Zoho CRM Leads for people who
 * verified OTP 30+ minutes ago but never completed booking or GBP redirect.
 *
 * Reads per-number funnel hashes from Redis (via the `funnel:all` index set)
 * instead of the capped 500-event recent buffer — so no drop-off is ever
 * missed regardless of site traffic volume.
 *
 * Dedup: tracks pushed numbers in the `crm:pushed` set (30-day TTL) so the
 * same person never creates a duplicate CRM Lead across runs.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` ONLY when the
 * CRON_SECRET env var exists on the project. Without it every scheduled run is
 * rejected with 401 (this is what silently stopped the cron from Apr to Nov
 * 2026), so a missing CRON_SECRET is logged loudly.
 *
 * Time budget: Vercel caps this function at 60s (vercel.json maxDuration).
 * Redis reads are pipelined, and Zoho writes stop after ~40s; whatever is left
 * is picked up by the next run (or by calling the endpoint again manually).
 */
import { getRedis } from './_redis.js';
import { upsertFunnelLead } from './zoho/_crm.js';

const PUSHED_SET = 'crm:pushed';
const PUSHED_TTL = 60 * 60 * 24 * 30;      // 30 days
const DROPOFF_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const REDIS_BATCH = 200;                    // hashes per pipeline round-trip
const ZOHO_TIME_BUDGET_MS = 40 * 1000;      // stop starting new Zoho writes after this
const MAX_PER_RUN = 150;                    // hard cap on Zoho upserts per run

const DROP_STAGES  = new Set(['otp_verified', 'corpus_selected', 'details_submitted', 'slot_picked']);
const DONE_STAGES  = new Set(['booking_created', 'gbp_redirected']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

// Mask a phone number for logs / response: country code + last 3 digits only.
function mask(num) {
  const s = String(num || '');
  return s.length > 5 ? `${s.slice(0, 2)}...${s.slice(-3)}` : '...';
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
    if (!cronSecret) {
      console.error('[dropoff-leads] CRON_SECRET is not set on this Vercel project - scheduled runs cannot authenticate. Add CRON_SECRET to the Production environment.');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const started = Date.now();
  console.log(`[dropoff-leads] run started (${isValidCron ? 'cron' : 'manual'})`);

  try {
    const redis = getRedis();
    const now = Date.now();
    const cutoff = now - DROPOFF_THRESHOLD_MS;

    // 1. Enumerate every phone number we've seen (persistent index)
    const allNumbers = (await redis.smembers('funnel:all')) || [];
    console.log(`[dropoff-leads] scanning ${allNumbers.length} funnel numbers`);

    // 2. Read the per-number hashes in pipelined batches (one round-trip per
    //    200 numbers instead of one per number). Hashes expire after 30 days
    //    while the index set is refreshed on every event, so most index
    //    members point at nothing - prune those so the set stays small.
    const dropoffs = [];
    const expired = [];
    for (let i = 0; i < allNumbers.length; i += REDIS_BATCH) {
      const slice = allNumbers.slice(i, i + REDIS_BATCH);
      const p = redis.pipeline();
      for (const n of slice) p.hgetall(`funnel:${n}`);
      const hashes = await p.exec();

      slice.forEach((fullNum, idx) => {
        const hash = hashes[idx];
        if (!hash || !hash.last_stage) { expired.push(fullNum); return; }

        // Must have at least verified OTP and not finished
        if (!DROP_STAGES.has(hash.last_stage)) return;
        if (DONE_STAGES.has(hash.last_stage)) return;

        const lastTs = parseInt(hash.last_ts || '0', 10);
        if (!lastTs || lastTs > cutoff) return; // too recent

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
      });
    }

    let pruned = 0;
    for (let i = 0; i < expired.length; i += REDIS_BATCH) {
      pruned += await redis.srem('funnel:all', ...expired.slice(i, i + REDIS_BATCH));
    }

    // 3. Drop the ones already pushed in a previous run (one pipelined check)
    let pending = dropoffs;
    if (dropoffs.length) {
      const p = redis.pipeline();
      for (const d of dropoffs) p.sismember(PUSHED_SET, d.fullNum);
      const flags = await p.exec();
      pending = dropoffs.filter((d, idx) => !flags[idx]);
    }
    const alreadyPushed = dropoffs.length - pending.length;

    // Newest drop-offs first: they are the warmest leads for the sales team.
    pending.sort((a, b) => b.last_ts - a.last_ts);

    console.log(`[dropoff-leads] ${dropoffs.length} eligible drop-offs, ${alreadyPushed} already in CRM, ${pending.length} to push, ${pruned} stale index entries pruned`);

    let created = 0, updated = 0, skipped = 0, failed = 0, deferred = 0;
    const results = [];

    for (const d of pending) {
      if (!d.country_code || !d.mobile) { skipped++; continue; }

      if (created + updated + failed >= MAX_PER_RUN || Date.now() - started > ZOHO_TIME_BUDGET_MS) {
        deferred++;
        continue;
      }

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

        if (!result.ok) {
          throw new Error(`Zoho ${result.action} returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 300)}`);
        }

        await redis.sadd(PUSHED_SET, d.fullNum);
        await redis.expire(PUSHED_SET, PUSHED_TTL);

        if (result.action === 'create') created++; else updated++;
        results.push({
          number: mask(d.fullNum),
          stage: d.last_stage,
          corpus: d.corpus || null,
          last_active: new Date(d.last_ts).toISOString(),
          action: result.action,
          lead_id: result.id
        });

        console.log(`[dropoff-leads] ${result.action} lead for ${mask(d.fullNum)} at "${d.last_stage}" -> ${result.id}`);
      } catch (err) {
        failed++;
        console.error(`[dropoff-leads] failed for ${mask(d.fullNum)}:`, err.message);
        results.push({
          number: mask(d.fullNum),
          stage: d.last_stage,
          error: err.message
        });
      }
    }

    console.log(`[dropoff-leads] done in ${Date.now() - started}ms: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed, ${deferred} deferred to next run`);

    return res.status(200).json({
      ok: true,
      scanned: allNumbers.length,
      pruned_from_index: pruned,
      total_dropoffs_found: dropoffs.length,
      already_in_crm: alreadyPushed,
      created,
      updated,
      skipped,
      failed,
      deferred,
      elapsed_ms: Date.now() - started,
      results
    });
  } catch (err) {
    console.error('[dropoff-leads] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
