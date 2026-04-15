/**
 * Zoho Bookings API client.
 *
 * - Caches OAuth access tokens in Upstash Redis for ~55 minutes so we don't
 *   hammer the Zoho accounts server on every cold start.
 * - Auto-refreshes using the refresh token when the cached access token is missing.
 *
 * Env vars (set in Vercel):
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN
 *
 * Hardcoded for India DC (enrichwise.zohobookings.in → zohoapis.in).
 */
import { getRedis } from '../_redis.js';

const ZOHO_ACCOUNTS = 'https://accounts.zoho.in';
const ZOHO_API = 'https://www.zohoapis.in';
const TOKEN_KEY = 'zoho:access_token';

async function refreshAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zoho token refresh failed: ${res.status} ${text}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Zoho token refresh returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!data.access_token) {
    throw new Error(`Zoho token refresh missing access_token: ${text.slice(0, 200)}`);
  }

  // Cache in Upstash for 55 minutes (tokens last 1 hour)
  try {
    const redis = getRedis();
    await redis.set(TOKEN_KEY, data.access_token, { ex: 3300 });
  } catch (err) {
    console.warn('[zoho] could not cache access token:', err.message);
  }

  return data.access_token;
}

export async function getAccessToken() {
  try {
    const redis = getRedis();
    const cached = await redis.get(TOKEN_KEY);
    if (cached) return cached;
  } catch (err) {
    console.warn('[zoho] cache read failed, refreshing directly:', err.message);
  }
  return refreshAccessToken();
}

async function zohoFetch(path, { method = 'GET', query, body, retryOn401 = true } = {}) {
  const token = await getAccessToken();

  let url = `${ZOHO_API}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const init = {
    method,
    headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
  };
  if (body) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString();
  }

  const res = await fetch(url, init);
  const text = await res.text();

  // Access token expired mid-flight — invalidate cache and retry once
  if (res.status === 401 && retryOn401) {
    try {
      const redis = getRedis();
      await redis.del(TOKEN_KEY);
    } catch {}
    return zohoFetch(path, { method, query, body, retryOn401: false });
  }

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { status: res.status, ok: res.ok, data };
}

export function zohoGet(path, query) {
  return zohoFetch(path, { query });
}

export function zohoPost(path, body) {
  return zohoFetch(path, { method: 'POST', body });
}
