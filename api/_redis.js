/**
 * Shared Upstash Redis client (HTTP REST, serverless-friendly).
 * Reads env vars injected by Vercel's Upstash marketplace integration:
 *   UPSTASH_REDIS_KV_REST_API_URL
 *   UPSTASH_REDIS_KV_REST_API_TOKEN
 *
 * USAGE COUNT (added 27-Nov-26, after the database hit Upstash's 500,000
 * commands-a-month free limit and the site could not send OTPs for about
 * three hours). Every command sent through this client is counted, so the
 * daily job can warn before a month's usage gets out of hand.
 *
 * Counting every command exactly would itself cost a command each time, so
 * it is SAMPLED: each command has a 1 in SAMPLE_EVERY chance of adding
 * SAMPLE_EVERY to today's counter. Over thousands of commands a day that is
 * accurate to a few percent, costs about 5% extra, and loses nothing when a
 * serverless instance shuts down (there is no batch waiting to be written).
 * The sampling command itself is not counted, so the true total is about 5%
 * above the counter.
 *
 * Counter: usage:redis:day:YYYY-MM-DD (UTC day, kept 70 days). Read it with
 * readRedisUsage() below.
 */
import { Redis } from '@upstash/redis';

export const SAMPLE_EVERY = 20;
const DAY_KEY_TTL = 70 * 86400;

let raw = null;      // the real client
let sampler = null;  // same database, no retries: a failed count must never slow a visitor down
let counted = null;  // the same client, with commands counted
const expiredFor = new Set(); // day keys this instance has already set an expiry on

// Not commands: building blocks and plumbing that send nothing by themselves.
const NOT_COMMANDS = new Set([
  'pipeline', 'multi', 'autoPipeline', 'use', 'createScript', 'constructor',
  'then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf', 'readYourWritesSyncToken'
]);

function dayKey() {
  return `usage:redis:day:${new Date().toISOString().slice(0, 10)}`;
}

// How many of n commands land in the sample. Usually 0, so usually free.
function sampledOf(n) {
  let hits = 0;
  for (let i = 0; i < n; i++) if (Math.random() < 1 / SAMPLE_EVERY) hits++;
  return hits;
}

async function recordSample(hits) {
  if (!hits) return;
  try {
    const key = dayKey();
    await sampler.incrby(key, hits * SAMPLE_EVERY);
    if (!expiredFor.has(key)) {
      expiredFor.add(key);
      await sampler.expire(key, DAY_KEY_TTL);
    }
  } catch {
    // Counting must never break the site. If the database is down the
    // real command fails too, and that is what gets reported.
  }
}

function wrapPipeline(pipe) {
  let queued = 0;
  const proxy = new Proxy(pipe, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'exec') {
        return async (...args) => {
          const hits = sampledOf(queued);
          queued = 0;
          const result = await value.apply(target, args);
          await recordSample(hits);
          return result;
        };
      }
      if (NOT_COMMANDS.has(prop)) return value.bind(target);
      return (...args) => {
        queued++;
        const out = value.apply(target, args);
        return out === target ? proxy : out; // keep chained calls counted
      };
    }
  });
  return proxy;
}

function wrapClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'pipeline' || prop === 'multi') {
        return (...args) => wrapPipeline(value.apply(target, args));
      }
      if (NOT_COMMANDS.has(prop)) return value.bind(target);
      return async (...args) => {
        const hits = sampledOf(1);
        const result = await value.apply(target, args);
        await recordSample(hits);
        return result;
      };
    }
  });
}

export function getRedis() {
  if (counted) return counted;

  const url = process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('Upstash REST env vars are not set');
  }

  raw = new Redis({ url, token });
  sampler = new Redis({ url, token, retry: false });
  counted = wrapClient(raw);
  return counted;
}

/**
 * Estimated commands per UTC day for the last `days` days, newest first:
 * [{ date: 'YYYY-MM-DD', commands: n }]. Days with no counter are left out
 * (counting started 27-Nov-26).
 */
export async function readRedisUsage(days = 35) {
  getRedis();
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const values = await raw.mget(...dates.map(d => `usage:redis:day:${d}`));
  const out = [];
  dates.forEach((date, i) => {
    if (values[i] !== null && values[i] !== undefined) out.push({ date, commands: Number(values[i]) });
  });
  return out;
}

// For tests only.
export function _resetRedisForTests() {
  raw = null;
  sampler = null;
  counted = null;
  expiredFor.clear();
}
