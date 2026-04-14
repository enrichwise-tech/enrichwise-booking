/**
 * Shared Redis client for the booking app.
 * Reads KV_REDIS_URL injected by Vercel's Redis (Upstash) integration.
 * Cached across invocations on a warm Lambda.
 */
import { createClient } from 'redis';

let client = null;

export async function getRedis() {
  if (client && client.isOpen) return client;

  const url = process.env.KV_REDIS_URL;
  if (!url) throw new Error('KV_REDIS_URL env var is not set');

  client = createClient({ url });
  client.on('error', (err) => console.error('Redis error:', err));
  await client.connect();
  return client;
}
