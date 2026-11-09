// Run: npm install && node tests/verify-otp-gbp.test.mjs
// Simulated Redis and Zoho. Checks the GBP lookup after OTP verification.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
console.error = () => {}; console.warn = () => {};

const store = new Map();
let zoho = { mode: 'none', delayMs: 0 };
let searches = [];

function redisCmd([op, ...a]) {
  const O = String(op).toLowerCase();
  if (O === 'get') return store.has(a[0]) ? store.get(a[0]) : null;
  if (O === 'set') { store.set(a[0], a[1]); return 'OK'; }
  if (O === 'del') return store.delete(a[0]) ? 1 : 0;
  if (O === 'incr') { const v = Number(store.get(a[0]) || 0) + 1; store.set(a[0], String(v)); return v; }
  if (O === 'expire') return 1;
  if (O === 'hincrby') return 1;
  throw new Error('cmd ' + op);
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
  if (url.startsWith('http://redis.test')) {
    const body = JSON.parse(init.body);
    const enc = new Headers(init.headers).get('upstash-encoding') === 'base64';
    const wrap = v => (enc && typeof v === 'string' ? Buffer.from(v).toString('base64') : v);
    if (url.endsWith('/pipeline')) return J(body.map(c => ({ result: wrap(redisCmd(c)) })));
    return J({ result: wrap(redisCmd(body)) });
  }
  const u = new URL(url);
  assert.ok(u.pathname.endsWith('/crm/v6/Leads/search'), 'only a Leads search: ' + u.pathname);
  searches.push(u.searchParams.get('criteria'));
  if (zoho.delayMs) await new Promise(r => setTimeout(r, zoho.delayMs));
  if (zoho.mode === 'fail') return J({ code: 'INTERNAL_ERROR' }, 500);
  if (zoho.mode === 'none') return new Response(null, { status: 204 });
  if (zoho.mode === 'notgbp') return J({ data: [{ id: '1', GBP_form_received: false, First_Name: 'A', Last_Name: 'B', Email: 'a@b.co' }] });
  return J({ data: [
    { id: '1', GBP_form_received: false, First_Name: 'Old', Last_Name: 'Record', Email: 'old@x.co' },
    { id: '2', GBP_form_received: true, First_Name: 'Asha', Last_Name: 'Rao', Email: 'asha@x.co', Phone: 'SECRET', Description: 'SECRET' }
  ] });
};
store.set('zoho:access_token', 'tok');

const handler = (await import('../api/verify-otp.js')).default;
const call = body => new Promise((resolve, reject) => {
  const out = { setHeader() {}, end() { resolve(out); } };
  out.status = c => { out.code = c; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  Promise.resolve(handler({ method: 'POST', body }, out)).catch(reject);
});
const verify = async (extra = {}) => {
  store.set('otp:919876543210', '123456');
  store.delete('verify_attempts:919876543210');
  searches = [];
  return call({ mobile: '9876543210', country_code: '91', otp: '123456', ...extra });
};

let r = await verify({ check_gbp: true }); zoho.mode = 'gbp';
r = await verify({ check_gbp: true });
assert.deepEqual(r.body, { valid: true, gbp_done: true, name: 'Asha Rao', email: 'asha@x.co' });
assert.equal(searches.length, 1, 'one Zoho search');
assert.match(searches[0], /Mobile:equals:919876543210/);
assert.match(searches[0], /Mobile:equals:9876543210\)/);
assert.match(searches[0], /Mobile:equals:\+919876543210/);
assert.ok(!JSON.stringify(r.body).includes('SECRET'), 'only name and email leave the server');

// NRI: country code as picked, and no bare-number match outside India
searches = []; store.set('otp:971501234567', '123456'); store.delete('verify_attempts:971501234567');
r = await call({ mobile: '501234567', country_code: '971', otp: '123456', check_gbp: true });
assert.equal(r.body.gbp_done, true);
assert.match(searches[0], /Mobile:equals:971501234567\)/);
assert.match(searches[0], /Mobile:equals:\+971501234567/);
assert.ok(!/Mobile:equals:501234567\)/.test(searches[0]), 'no bare match for non-91: ' + searches[0]);

zoho.mode = 'notgbp';
r = await verify({ check_gbp: true });
assert.deepEqual(r.body, { valid: true });

zoho.mode = 'none';
r = await verify({ check_gbp: true });
assert.deepEqual(r.body, { valid: true });

zoho.mode = 'fail';
r = await verify({ check_gbp: true });
assert.deepEqual(r.body, { valid: true }, 'Zoho error still verifies');

zoho = { mode: 'gbp', delayMs: 4000 };
const t0 = Date.now();
r = await verify({ check_gbp: true });
assert.deepEqual(r.body, { valid: true }, 'slow Zoho still verifies');
assert.ok(Date.now() - t0 < 3500, 'answers within about 2.5 s');
zoho.delayMs = 0;

r = await verify({});
assert.deepEqual(r.body, { valid: true });
assert.equal(searches.length, 0, 'no Zoho call without check_gbp');

store.set('otp:919876543210', '123456'); store.delete('verify_attempts:919876543210'); searches = [];
r = await call({ mobile: '9876543210', country_code: '91', otp: '000000', check_gbp: true });
assert.equal(r.code, 400);
assert.equal(searches.length, 0, 'no Zoho call on a wrong OTP');

console.log('ALL PASSED');
process.exit(0);
