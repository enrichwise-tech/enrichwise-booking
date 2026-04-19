/**
 * Funnel event logging helpers (Upstash Redis).
 *
 * Every funnel step (otp_sent, otp_verified, corpus_selected, details_submitted,
 * slot_picked, booking_created, gbp_redirected) gets logged as a small JSON entry
 * into three places so we can query it different ways:
 *
 *   1. events:recent      - capped list (last 500) for fast dashboards
 *   2. events:YYYY-MM-DD  - daily list for date-based queries
 *   3. funnel:{mobile}    - per-number hash tracking latest stage reached
 *
 * All reads live behind a query-key gate (ZOHO_INFO_KEY reused) so nobody can
 * scrape funnel data.
 */
import { getRedis } from './_redis.js';

const RECENT_LIST = 'events:recent';
const RECENT_MAX = 500;

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `events:${yyyy}-${mm}-${dd}`;
}

export async function logEvent(evt) {
  const redis = getRedis();
  const record = {
    ts: evt.ts || Date.now(),
    type: evt.type || 'unknown',
    mobile: evt.mobile || '',
    country_code: evt.country_code || '',
    track: evt.track || '',
    ...evt
  };
  // De-dupe redundant fields already promoted up
  delete record.mobile_full;

  const json = JSON.stringify(record);
  const day = todayKey();

  // Push to the recent list and trim to the cap
  await Promise.all([
    redis.lpush(RECENT_LIST, json),
    redis.lpush(day, json)
  ]);

  // Keep the recent list bounded; daily list expires on its own
  await Promise.all([
    redis.ltrim(RECENT_LIST, 0, RECENT_MAX - 1),
    redis.expire(day, 60 * 60 * 24 * 60) // 60-day retention for daily lists
  ]);

  // Per-number funnel state (which stage was the most recent) + context
  if (record.mobile) {
    const fullNumber = `${record.country_code || ''}${record.mobile}`;
    const hash = {
      last_stage: record.type,
      last_ts: String(record.ts),
      country_code: record.country_code || '',
      mobile: record.mobile || ''
    };
    if (record.name)     hash.name = String(record.name);
    if (record.email)    hash.email = String(record.email);
    if (record.corpus)   hash.corpus = String(record.corpus);
    if (record.topics)   hash.topics = Array.isArray(record.topics) ? record.topics.join(', ') : String(record.topics);
    if (record.mode)     hash.mode = String(record.mode);
    if (record.platform) hash.platform = String(record.platform);
    if (record.date)     hash.date = String(record.date);
    if (record.slot)     hash.slot = String(record.slot);

    await redis.hset(`funnel:${fullNumber}`, hash);
    await redis.expire(`funnel:${fullNumber}`, 60 * 60 * 24 * 30); // 30 days

    // Maintain index set so the cron can enumerate all funnel numbers
    // (without relying on the capped events:recent list)
    await redis.sadd('funnel:all', fullNumber);
    await redis.expire('funnel:all', 60 * 60 * 24 * 35); // 35 days, slightly > hash TTL
  }
}

export async function getRecentEvents(limit = 200) {
  const redis = getRedis();
  const raw = await redis.lrange(RECENT_LIST, 0, Math.max(0, limit - 1));
  return (raw || []).map(s => {
    try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return { raw: s }; }
  });
}
