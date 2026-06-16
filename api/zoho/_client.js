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
  const clientId = (process.env.ZOHO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.ZOHO_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.ZOHO_REFRESH_TOKEN || '').trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Zoho env vars missing (hasClientId=${!!clientId} hasSecret=${!!clientSecret} hasRefresh=${!!refreshToken})`);
  }

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
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

// Distributed lock around the OAuth token refresh. Without it, multiple
// Vercel function instances hitting an expired cache simultaneously each
// independently refresh against accounts.zoho.in, blowing through Zoho's
// 30/hour OAuth rate limit and triggering "Access Denied" 400s. With it,
// only ONE instance refreshes per cycle; the rest wait and re-read the
// cache that the winning instance writes.
const LOCK_KEY = 'zoho:refresh_lock';
const LOCK_TTL_SEC = 15;        // max refresh duration before we let others retry
const WAIT_POLL_MS = 200;       // how often to re-check cache while waiting
const WAIT_MAX_ATTEMPTS = 10;   // total ~2s wait before giving up and refreshing ourselves

export async function getAccessToken() {
  // 1. Try cache first — happy path, no contention
  let redis;
  try {
    redis = getRedis();
    const cached = await redis.get(TOKEN_KEY);
    if (cached) return cached;
  } catch (err) {
    console.warn('[zoho] cache read failed, refreshing directly:', err.message);
    return refreshAccessToken();
  }

  // 2. Cache miss — try to acquire the refresh lock
  let lockAcquired = false;
  try {
    const ok = await redis.set(LOCK_KEY, String(Date.now()), { nx: true, ex: LOCK_TTL_SEC });
    lockAcquired = !!ok;
  } catch (err) {
    // Lock infra broken — fall through to direct refresh, accepting some
    // risk of double-refresh rather than blocking all bookings.
    console.warn('[zoho] lock acquire failed, refreshing directly:', err.message);
    return refreshAccessToken();
  }

  if (lockAcquired) {
    // 3a. We own the refresh — do it, then release
    try {
      return await refreshAccessToken();
    } finally {
      try { await redis.del(LOCK_KEY); } catch {}
    }
  }

  // 3b. Another instance is refreshing — poll cache for the new token
  for (let i = 0; i < WAIT_MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, WAIT_POLL_MS));
    try {
      const cached = await redis.get(TOKEN_KEY);
      if (cached) return cached;
    } catch {}
  }

  // 4. Lock holder didn't finish in time (e.g. crashed) — refresh ourselves
  // as a fallback. The lock will auto-expire via its TTL.
  console.warn('[zoho] lock holder timed out, refreshing as fallback');
  return refreshAccessToken();
}

async function zohoFetch(path, { method = 'GET', query, body, json = false, retryOn401 = true } = {}) {
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
  if (body !== undefined) {
    if (json) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    } else {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString();
    }
  }

  const res = await fetch(url, init);
  const text = await res.text();

  // Access token expired mid-flight — invalidate cache and retry once
  if (res.status === 401 && retryOn401) {
    try {
      const redis = getRedis();
      await redis.del(TOKEN_KEY);
    } catch {}
    return zohoFetch(path, { method, query, body, json, retryOn401: false });
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

// JSON variants for Zoho CRM v6 API (which expects application/json)
export function zohoGetJson(path, query) {
  return zohoFetch(path, { query });
}

export function zohoPostJson(path, body) {
  return zohoFetch(path, { method: 'POST', body, json: true });
}

export function zohoPutJson(path, body) {
  return zohoFetch(path, { method: 'PUT', body, json: true });
}
