// Run: npm install && node tests/book-duplicates.test.mjs
// Simulated Redis and Zoho. Nothing here talks to the real Zoho Bookings:
// a real POST to /bookings/v1/json/appointment would create a REAL booking.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZOHO_CLIENT_ID = 'id';
process.env.ZOHO_CLIENT_SECRET = 'secret';
process.env.ZOHO_REFRESH_TOKEN = 'refresh';
console.error = () => {}; console.warn = () => {}; console.log = () => {};

const store = new Map();
let created = [];      // every appointment POST that reached "Zoho"
let redisDown = false;

function redisCmd([op, ...a]) {
  const O = String(op).toLowerCase();
  if (O === 'get') return store.has(a[0]) ? store.get(a[0]) : null;
  if (O === 'set') { store.set(a[0], a[1]); return 'OK'; }
  if (O === 'del') return store.delete(a[0]) ? 1 : 0;
  if (O === 'incr') { const v = Number(store.get(a[0]) || 0) + 1; store.set(a[0], String(v)); return v; }
  if (O === 'expire' || O === 'hincrby' || O === 'setex') return 1;
  throw new Error('cmd ' + op);
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });

  if (url.startsWith('http://redis.test')) {
    if (redisDown) throw new Error('redis unreachable');
    const body = JSON.parse(init.body);
    const enc = new Headers(init.headers).get('upstash-encoding') === 'base64';
    const wrap = v => (enc && typeof v === 'string' ? Buffer.from(v).toString('base64') : v);
    if (url.endsWith('/pipeline')) return J(body.map(c => ({ result: wrap(redisCmd(c)) })));
    return J({ result: wrap(redisCmd(body)) });
  }
  if (url.includes('/oauth/v2/token')) return J({ access_token: 'tok', expires_in: 3600 });
  if (url.includes('fetchappointment')) return J({ response: { returnvalue: { response: 'No Match Found' } } });
  if (url.includes('/bookings/v1/json/appointment')) {
    created.push(url);
    return J({ response: { returnvalue: { status: 'success', booking_id: '#EN-99' + created.length, staff_name: 'Vicky Singh' } } });
  }
  throw new Error('unexpected call: ' + url);
};

const handler = (await import('../api/zoho/book.js')).default;
const dupes = await import('../api/zoho/_dupes.js');

const BASE = {
  track: 'instant', name: 'Test Person', email: 't@example.com',
  mobile: '9000000001', country_code: '91', corpus: '₹1 Cr – ₹5 Cr'
};
const book = body => new Promise((resolve, reject) => {
  const out = { setHeader() {}, end() { resolve(out); } };
  out.status = c => { out.code = c; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  Promise.resolve(handler({ method: 'POST', body: { ...BASE, ...body } }, out)).catch(reject);
});

// A date that is definitely in the future, so "upcoming" logic is exercised.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const future = n => {
  const d = new Date(Date.now() + n * 86400000);
  return `${String(d.getUTCDate()).padStart(2,'0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};
const D1 = future(5), D2 = future(6);

// 1. First booking goes through and is remembered.
let r = await book({ date: D1, slot: '3:00 PM' });
assert.equal(r.body.ok, true, 'first booking should succeed');
assert.equal(created.length, 1);
const remembered = await dupes.findUpcomingBooking('91', '9000000001');
assert.ok(remembered, 'the booking should be remembered');
assert.equal(remembered.date, D1);

// 2. A second booking on the same mobile is stopped, with no Zoho booking made.
created = [];
r = await book({ date: D2, slot: '4:30 PM' });
assert.equal(r.code, 409);
assert.equal(created.length, 0, 'must not reach Zoho');
assert.ok(r.body.duplicate, 'the page needs the duplicate details');
assert.equal(r.body.duplicate.date, D1);
assert.match(r.body.error, /already have a consultation/);
// The page treats "not available" style wording as a stale slot and reloads
// the calendar; this warning must not be mistaken for that.
const STALE_SLOT_RE = /slot not available|not available|unavailable|busy|invalid booking time|already booked/i;
assert.ok(!STALE_SLOT_RE.test(r.body.error), 'wording must not look like a stale slot: ' + r.body.error);

// 3. Clicking "Book another anyway" goes through.
r = await book({ date: D2, slot: '4:30 PM', confirm_duplicate: true });
assert.equal(r.body.ok, true, 'confirming should book');
assert.equal(created.length, 1);

// 4. A different mobile is unaffected.
created = [];
r = await book({ date: D1, slot: '3:00 PM', mobile: '9000000002' });
assert.equal(r.body.ok, true);
assert.equal(created.length, 1);

// 5. A booking already in the past never warns.
store.clear();
await dupes.rebuildDuplicateIndex([
  { customer_contact_no: '+919000000003', start_time: '01-Jan-2020 15:00:00', status: 'completed', booking_id: '#EN-1', service_id: 's' }
]);
assert.equal(await dupes.findUpcomingBooking('91', '9000000003'), null, 'past bookings must not warn');

// 6. Cancelled bookings are dropped, so a rebook is clean.
store.clear();
await dupes.rebuildDuplicateIndex([
  { customer_contact_no: '+919000000004', start_time: `${D1} 15:00:00`, status: 'cancel', booking_id: '#EN-2', service_id: 's' },
  { customer_contact_no: '+919000000005', start_time: `${D1} 15:00:00`, status: 'upcoming', booking_id: '#EN-3', service_id: 's' }
]);
assert.equal(await dupes.findUpcomingBooking('91', '9000000004'), null, 'a cancelled booking must not warn');
assert.equal((await dupes.findUpcomingBooking('91', '9000000005')).booking_id, 'EN-3');

// 7. A booking made on Zoho's own page is seen by the check (the index is
//    rebuilt from Zoho daily), which is the case Zoho's own limit misses.
created = [];
r = await book({ date: D2, slot: '4:30 PM', mobile: '9000000005' });
assert.equal(r.code, 409);
assert.equal(created.length, 0);

// 8. Country code is part of the match: same digits, different country.
assert.equal(await dupes.findUpcomingBooking('971', '9000000005'), null, 'must not match across countries');

// 9. If Redis cannot be read the booking still goes through.
redisDown = true;
assert.equal(await dupes.findUpcomingBooking('91', '9000000005'), null, 'no lookup, no block');
redisDown = false;

console.log = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log('ALL PASSED');
process.exit(0);
