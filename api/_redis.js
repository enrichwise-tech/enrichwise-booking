/**
 * Shared Upstash Redis client (HTTP REST, serverless-friendly).
 * Reads env vars injected by Vercel's Upstash marketplace integration:
 *   UPSTASH_REDIS_KV_REST_API_URL
 *   UPSTASH_REDIS_KV_REST_API_TOKEN
 */
import { Redis } from '@upstash/redis';

let client = null;

export function getRedis() {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('Upstash REST env vars are not set');
  }

  client = new Redis({ url, token });
  return client;
}
