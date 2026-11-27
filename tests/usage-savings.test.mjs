// Run: node tests/usage-savings.test.mjs
// Simulated Upstash, Zoho and Periskope. Checks the 27-Nov-26 changes made
// after the database hit its monthly command limit:
//   - commands are counted (sampled) and counting can never break a request
//   - the Zoho token is reused from memory, and dropped on a dead token
//   - Zoho call counts are batched, and still add up
//   - visitor-step housekeeping runs once, not on every step
//   - cap counts are held in memory, but a fresh check always goes to Zoho
//   - the usage warning maths, and that it is sent once a month
//   - the database-down alert is sent at most once an hour
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZOHO_CLIENT_ID = 'id';
process.env.ZOHO_CLIENT_SECRET = 'secret';
process.env.ZOHO_REFRESH_TOKEN = 'refresh';
process.env.PERISKOPE_API_KEY = 'k';
process.env.PERISKOPE_PHONE = '910000000000';
process.env.PERISKOPE_ALERT_CHAT_ID = 'test@g.us';
console.error = () => {}; console.warn = () => {};
const say = console.log;
console.log = () => {};

const store = new Map();
let ops = [];            // every Redis command, as [op, key]
let alerts = [];         // Periskope messages
let zohoStatus = 200;
let redisBroken = false;
let incrbyBroken = false;

function cmd([op, ...a]) {
  const O = String(op).toLowerCase();
  ops.push([O, a[0]]);
  if (redisBroken) throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');
  if (O === 'get') return store.has(a[0]) ? store.get(a[0]) : null;
  if (O === 'set') {
    const nx = a.map(x => String(x).toLowerCase()).includes('nx');
    if (nx && store.has(a[0])) return null;
    store.set(a[0], String(a[1])); return 'OK';
  }
  if (O === 'del') return store.delete(a[0]) ? 1 : 0;
  if (O === 'incrby') {
    if (incrbyBroken) throw new Error('incrby down');
    const v = Number(store.get(a[0]) || 0) + Number(a[1]); store.set(a[0], String(v)); return v;
  }
  if (O === 'incr') { const v = Number(store.get(a[0]) || 0) + 1; store.set(a[0], String(v)); return v; }
  if (O === 'hincrby') {
    const h = store.get(a[0]) || {}; h[a[1]] = (h[a[1]] || 0) + Number(a[2]); store.set(a[0], h); return h[a[1]];
  }
  if (O === 'hgetall') { const h = store.get(a[0]); return h ? Object.entries(h).flat().map(String) : []; }
  if (O === 'mget') return a.map(k => (store.has(k) ? store.get(k) : null));
  if (['expire', 'lpush', 'ltrim', 'hset', 'sadd'].includes(O)) return 1;
  throw new Error('unknown cmd ' + op);
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
  if (url.startsWith('http://redis.test')) {
    const body = JSON.parse(init.body);
    const enc = new Headers(init.headers).get('upstash-encoding') === 'base64';
    const wrap = v => (enc && typeof v === 'string' ? Buffer.from(v).toString('base64')
      : (enc && Array.isArray(v) ? v.map(wrap) : v));
    try {
      if (url.endsWith('/pipeline')) return J(body.map(c => ({ result: wrap(cmd(c)) })));
      return J({ result: wrap(cmd(body)) });
    } catch (err) {
      return J({ error: err.message }, 400);
    }
  }
  if (url.includes('/oauth/v2/token')) return J({ access_token: 'fresh-token', expires_in: 3600 });
  if (url.includes('api.periskope.app')) { alerts.push(JSON.parse(init.body).message); return J({ ok: true }); }
  if (url.includes('zohoapis.in')) {
    if (zohoStatus === 401) { zohoStatus = 200; return J({ code: 'INVALID_TOKEN' }, 401); }
    if (url.includes('fetchappointment')) return J({ response: { returnvalue: { response: 'No Match Found' } } });
    return J({ response: { returnvalue: { data: [] } } });
  }
  throw new Error('unexpected call: ' + url);
};

const { getRedis, SAMPLE_EVERY } = await import('../api/_redis.js');
const { zohoGet } = await import('../api/zoho/_client.js');
const { flushZohoUsage, _pendingZohoCalls } = await import('../api/zoho/_usage.js');
const { logEvent } = await import('../api/_events.js');
const { checkCap, clearCountCache } = await import('../api/zoho/_caps.js');
const { assessUsage, checkRedisUsage, WARN_AT } = await import('../api/_usage-check.js');
const { alertDatabaseDown } = await import('../api/_alert.js');

const realRandom = Math.random;
const today = new Date().toISOString().slice(0, 10);
const usageKey = `usage:redis:day:${today}`;
const count = (op, keyPart = '') => ops.filter(([o, k]) => o === op && String(k || '').includes(keyPart)).length;

// ── 1. Sampled counting ──
const redis = getRedis();
Math.random = () => 0;          // every command sampled
ops = [];
await redis.set('a', '1');
await redis.get('a');
assert.equal(store.get(usageKey), String(2 * SAMPLE_EVERY), 'two commands counted as 2 x sample size');
assert.equal(count('expire', 'usage:redis:day'), 1, 'counter expiry set once');
const p = redis.pipeline();
p.set('b', '1').set('c', '1');  // chained calls must count too
p.get('b');
await p.exec();
assert.equal(store.get(usageKey), String(5 * SAMPLE_EVERY), 'pipeline commands each counted');

Math.random = () => 0.99;       // nothing sampled: no extra command at all
ops = [];
assert.equal(Number(await redis.get('a')), 1);
assert.equal(ops.length, 1, 'unsampled command costs exactly one command');

Math.random = () => 0;
incrbyBroken = true;            // counting fails: the real answer still comes back, fast
const t0 = Date.now();
assert.equal(Number(await redis.get('a')), 1);
assert.ok(Date.now() - t0 < 500, 'a failed count does not retry or stall');
incrbyBroken = false;
Math.random = () => 0.99;       // keep the rest of the test free of sample noise

// ── 2. Zoho token from memory ──
store.set('zoho:access_token', 'cached-token');
ops = [];
await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
assert.equal(count('get', 'zoho:access_token'), 1, 'token read from the database once, then memory');

zohoStatus = 401;               // dead token: forget both copies, refresh, retry
ops = [];
await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
assert.equal(count('del', 'zoho:access_token'), 1, 'dead token removed from the database');
assert.equal(store.get('zoho:access_token'), 'fresh-token', 'fresh token saved');
ops = [];
await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
assert.equal(count('get', 'zoho:access_token'), 0, 'fresh token reused from memory');

// ── 3. Zoho call counts batched ──
await flushZohoUsage();
const istDay = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const zKey = `zoho:usage:${istDay}`;
const before = (store.get(zKey) || {}).total || 0;
ops = [];
for (let i = 0; i < 10; i++) await zohoGet('/bookings/v1/json/availableslots', { service_id: '1' });
assert.equal(count('hincrby'), 0, 'bulk calls are held, not written one by one');
assert.equal(_pendingZohoCalls(), 10);
await flushZohoUsage();
assert.equal(store.get(zKey).total, before + 10, 'all ten counted after the flush');
assert.ok(count('hincrby') <= 3, 'one batch: a handful of commands, not 30');
ops = [];
await zohoGet('/crm/v6/Leads/search', { criteria: 'x' });
assert.equal(_pendingZohoCalls(), 0, 'other calls are written straight away');
assert.equal(store.get(zKey)['crm:Leads/search'], 1);
assert.equal(count('expire', 'zoho:usage'), 0, 'day expiry not repeated');
ops = [];
for (let i = 0; i < 30; i++) await zohoGet('/bookings/v1/json/fetchappointment', { data: '{}' });
assert.ok(_pendingZohoCalls() < 25, 'a long run flushes itself every 25 calls');
await flushZohoUsage();

// ── 4. Visitor-step housekeeping once ──
ops = [];
for (let i = 0; i < 12; i++) await logEvent({ type: 'otp_sent', mobile: '9000000001', country_code: '91' });
assert.equal(count('lpush'), 24, 'every step still logged twice (recent + day)');
assert.equal(count('expire', 'events:'), 1, 'day list expiry set once');
assert.equal(count('expire', 'funnel:all'), 1, 'index expiry set once');
assert.equal(count('ltrim'), 1, 'recent list trimmed every 10 steps, not every step');
assert.equal(count('expire', 'funnel:91'), 12, 'per-person record still refreshed every step');

// ── 5. Cap counts held in memory ──
const MAIN = '279048000000733018';
store.set(`zoho:count:${MAIN}:02-Dec-2026`, '41');
ops = [];
let c = await checkCap(MAIN, '02-Dec-2026');
assert.equal(c.count, 41);
c = await checkCap(MAIN, '02-Dec-2026');
assert.equal(c.source, 'memory');
assert.equal(count('get', 'zoho:count:'), 1, 'second look comes from memory');
ops = [];
c = await checkCap(MAIN, '02-Dec-2026', { fresh: true });
assert.equal(c.source, 'zoho', 'a fresh check (used by bookings) always asks Zoho');
await clearCountCache(MAIN, '02-Dec-2026');
ops = [];
await checkCap(MAIN, '02-Dec-2026');
assert.equal(count('get', 'zoho:count:') + count('get', 'zoho:count_last'), 1, 'after a booking the memory copy is gone');

// ── 6. Usage maths ──
const day = (d, n) => ({ date: d, commands: n });
let u = assessUsage([day('2026-12-10', 3000), day('2026-12-09', 12000), day('2026-12-08', 12000), day('2026-12-07', 12000)],
  new Date('2026-12-10T05:00:00Z'));
assert.equal(u.daily_rate, 12000, 'daily rate from complete days only');
assert.equal(u.month_to_date, 39000);
// 39,000 so far + 12,000 x (6 uncounted days 1-6 Dec + 21 days left) = 363,000
assert.equal(u.projected, 363000);
assert.equal(u.warn, false);
u = assessUsage([day('2026-12-10', 3000), day('2026-12-09', 20000), day('2026-12-08', 20000)], new Date('2026-12-10T05:00:00Z'));
assert.ok(u.projected >= WARN_AT && u.warn, 'heading for 600,000: warns');
u = assessUsage([day('2026-12-01', 100)], new Date('2026-12-01T05:00:00Z'));
assert.equal(u.projected, null, 'no complete day yet: no projection, no warning');
assert.equal(u.warn, false);

// ── 7. Warning sent once a month ──
for (let i = 1; i <= 5; i++) {
  const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
  store.set(`usage:redis:day:${d}`, '30000');
}
alerts = [];
let r = await checkRedisUsage();
assert.equal(r.warn, true);
assert.equal(alerts.length, 1, 'warned');
assert.match(alerts[0], /usage is high/);
r = await checkRedisUsage();
assert.equal(alerts.length, 1, 'not warned again the same month');

// ── 8. Database-down alert at most once an hour ──
alerts = [];
await alertDatabaseDown('send OTP (WhatsApp)', new Error('ERR max requests limit exceeded'));
await alertDatabaseDown('verify OTP', new Error('ERR max requests limit exceeded'));
assert.equal(alerts.length, 1, 'one alert, not a flood');
assert.match(alerts[0], /cannot get an OTP/);
assert.match(alerts[0], /monthly command limit/);

// ── 9. Database down: send-otp says so AND alerts (the 27-Nov-26 failure) ──
// The alert above already used this hour's slot, so check the route returns
// the same error the site gave that evening and does not crash.
redisBroken = true;
const sendOtp = (await import('../api/send-otp.js')).default;
const res = await new Promise(resolve => {
  const out = { setHeader() {}, end() { resolve(out); } };
  out.status = code => { out.code = code; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  sendOtp({ method: 'POST', body: { mobile: '9000000009', country_code: '91' } }, out);
});
assert.equal(res.code, 500);
assert.match(res.body.error, /Service unavailable/);
redisBroken = false;

Math.random = realRandom;
say('ALL PASSED');
process.exit(0);
