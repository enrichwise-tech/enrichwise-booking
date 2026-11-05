// Run: npm install && node tests/event-counts.test.mjs
// Uses a simulated database. Checks the response can only ever hold counts.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.EVENT_COUNTS_KEY = 'right-key';
console.error = () => {};

const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const PERSON = { mobile: '9000000001', country_code: '91', name: 'SECRET NAME', email: 'secret@example.com', booking_id: 'SECRET-ID' };
let lists = {};
let reads = [];
let failing = false;

globalThis.fetch = async (url, init = {}) => {
  if (failing) throw new Error('boom 9000000001 secret@example.com');
  const [cmd, key] = JSON.parse(init.body);
  assert.equal(cmd.toUpperCase(), 'LRANGE', 'endpoint must only read lists');
  reads.push(key);
  const result = lists[key] || [];
  const encoded = new Headers(init.headers).get('upstash-encoding') === 'base64';
  return new Response(JSON.stringify({ result: encoded ? result.map(s => Buffer.from(s).toString('base64')) : result }));
};

const handler = (await import('../api/event-counts.js')).default;
const call = (query, method = 'GET') => new Promise((resolve, reject) => {
  const out = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  out.status = c => { out.code = c; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  Promise.resolve(handler({ method, query }, out)).catch(reject);
});

const FIELDS = ['otp_sent', 'otp_verified', 'details_submitted', 'slot_picked', 'booking_created', 'gbp_redirected', 'unique_otp'];
const ev = (type, extra = {}) => JSON.stringify({ type, ...PERSON, ...extra });

// Wrong, missing and non-GET requests look like a page that doesn't exist.
for (const q of [{}, { key: 'wrong' }, { key: 'right-key-longer' }]) {
  const r = await call(q);
  assert.equal(r.code, 404);
  assert.deepEqual(r.body, { error: 'Not found' });
}
assert.equal((await call({ key: 'right-key' }, 'POST')).code, 404);

// Counts and allowed fields only, with no CORS header.
lists = {
  [`events:${day(0)}`]: [
    ev('otp_sent'), ev('otp_sent'), ev('otp_sent', { mobile: '9000000002' }), ev('otp_verified'),
    ev('details_submitted'), ev('slot_picked'), ev('booking_created'), ev('gbp_redirected'),
    ev('corpus_selected'), ev('unknown_type'), ev('constructor'), '{not json',
  ],
};
let r = await call({ key: 'right-key' });
assert.equal(r.code, 200);
assert.equal(r.headers['access-control-allow-origin'], undefined);
assert.deepEqual(Object.keys(r.body).sort(), ['days', 'ok']);
assert.deepEqual(r.body.days[day(0)], { otp_sent: 3, otp_verified: 1, details_submitted: 1, slot_picked: 1, booking_created: 1, gbp_redirected: 1, unique_otp: 2 });
assert.deepEqual(Object.keys(r.body.days[day(0)]).sort(), [...FIELDS].sort());
for (const v of Object.values(r.body.days[day(0)])) assert.ok(Number.isInteger(v));
assert.ok(!/SECRET|secret@|9000000/.test(JSON.stringify(r.body)), 'no client details in the response');

// A day with no data has no entry, not zeros.
assert.deepEqual(Object.keys(r.body.days), [day(0)]);

// days: default 3, capped at 10, bad values use the default.
for (const [q, want] of [[undefined, 3], ['5', 5], ['999', 10], ['0', 3], ['-4', 3], ['abc', 3]]) {
  reads = [];
  await call({ key: 'right-key', ...(q === undefined ? {} : { days: q }) });
  assert.equal(reads.length, want, `days=${q}`);
  assert.ok(reads.every(k => /^events:\d{4}-\d{2}-\d{2}$/.test(k)));
}

// A read failure is generic, with nothing from the underlying error.
failing = true;
r = await call({ key: 'right-key' });
assert.equal(r.code, 500);
assert.deepEqual(r.body, { ok: false, error: 'Could not read counts' });

console.log('ALL PASSED');
process.exit(0);
