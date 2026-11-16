// Run: npm install && node tests/book-duplicates.test.mjs
// Simulated Redis and Zoho. Nothing here talks to the real Zoho Bookings:
// a real POST to appointment/rescheduleappointment would move or create a
// REAL booking.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZOHO_CLIENT_ID = 'id';
process.env.ZOHO_CLIENT_SECRET = 'secret';
process.env.ZOHO_REFRESH_TOKEN = 'refresh';
console.error = () => {}; console.warn = () => {};
const say = console.log;
console.log = () => {};

const store = new Map();
let created = [];       // appointment POSTs that reached "Zoho"
let moved = [];         // rescheduleappointment POSTs that reached "Zoho"
let staffFree = null;   // null = the current consultant is free
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
  if (url.includes('rescheduleappointment')) {
    const form = new URLSearchParams(init.body);
    const staffId = form.get('staff_id');
    moved.push({ booking_id: form.get('booking_id'), start_time: form.get('start_time'), staff_id: staffId });
    if (staffFree && staffFree !== staffId) {
      return J({ response: { status: 'failure', returnvalue: { message: 'Staff Not Available' } } });
    }
    return J({ response: { status: 'success', returnvalue: { booking_id: form.get('booking_id'), staff_name: 'Vicky Singh', status: 'upcoming' } } });
  }
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
  mobile: '9000000001', country_code: '91', corpus: 'Rs 1 Cr - Rs 5 Cr'
};
const call = body => new Promise((resolve, reject) => {
  const out = { setHeader() {}, end() { resolve(out); } };
  out.status = c => { out.code = c; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  Promise.resolve(handler({ method: 'POST', body: { ...BASE, ...body } }, out)).catch(reject);
});

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const future = n => {
  const d = new Date(Date.now() + n * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};
const D1 = future(5), D2 = future(6);
const verify = mob => store.set(`otp_ok:91${mob}`, '1');

// 1. First booking goes through and is remembered.
let r = await call({ date: D1, slot: '3:00 PM' });
assert.equal(r.body.ok, true, 'first booking should succeed');
assert.equal(created.length, 1);
assert.equal((await dupes.findUpcomingBooking('91', '9000000001')).date, D1);

// 2. A second booking is refused outright, with no Zoho call.
created = [];
r = await call({ date: D2, slot: '4:30 PM' });
assert.equal(r.code, 409);
assert.equal(created.length, 0, 'must not reach Zoho');
assert.equal(r.body.duplicate.date, D1);
assert.equal(r.body.duplicate.can_reschedule, true);
assert.match(r.body.error, /already have a consultation/);
// The page treats "not available" wording as a stale slot and reloads the
// calendar; this must not be mistaken for that.
const STALE_SLOT_RE = /slot not available|not available|unavailable|busy|invalid booking time|already booked/i;
assert.ok(!STALE_SLOT_RE.test(r.body.error), 'wording must not look like a stale slot: ' + r.body.error);

// 3. There is no override: an old page sending the dropped flag still gets 409.
r = await call({ date: D2, slot: '4:30 PM', confirm_duplicate: true });
assert.equal(r.code, 409, 'the old override must no longer work');
assert.equal(created.length, 0);

// 4. Rescheduling needs a mobile that passed an OTP.
r = await call({ date: D2, slot: '4:30 PM', action: 'reschedule' });
assert.equal(r.code, 403, 'an unverified mobile must not move a booking');
assert.equal(moved.length, 0);

// 5. Verified: the existing booking moves, and none is created.
verify('9000000001');
r = await call({ date: D2, slot: '4:30 PM', action: 'reschedule' });
assert.equal(r.body.ok, true);
assert.equal(r.body.rescheduled, true);
assert.equal(created.length, 0, 'a reschedule must never create a booking');
assert.equal(moved.length, 1);
assert.equal(moved[0].booking_id, '#EN-991', 'the id comes from the index, not the request');
assert.equal(moved[0].start_time, `${D2} 16:30:00`);
assert.deepEqual(r.body.previous, { date: D1, slot: '3:00 PM' });
assert.equal((await dupes.findUpcomingBooking('91', '9000000001')).date, D2, 'the record follows the booking');

// 6. A reschedule can only move the booking held against that mobile: the
//    booking id in the request body is ignored.
moved = [];
verify('9000000005');
await dupes.rebuildDuplicateIndex([
  { customer_contact_no: '+919000000005', start_time: `${D1} 15:00:00`, status: 'upcoming', booking_id: '#EN-3', service_id: 's' }
]);
r = await call({ date: D2, slot: '4:30 PM', mobile: '9000000005', action: 'reschedule', booking_id: '#EN-991' });
assert.equal(r.body.ok, true);
assert.equal(moved[0].booking_id, '#EN-3', 'must move only the booking held for that mobile');

// 7. Asking to move it to the time it already has is refused.
r = await call({ date: D2, slot: '4:30 PM', mobile: '9000000005', action: 'reschedule' });
assert.equal(r.code, 409);
assert.match(r.body.error, /already have/i);

// 8. If the consultant is not free, the consultants offering that slot are
//    tried, and the customer is told plainly when none can take it.
moved = [];
staffFree = 'staff-B';
r = await call({ date: D1, slot: '3:00 PM', mobile: '9000000005', action: 'reschedule', staff_ids: ['staff-A', 'staff-B'] });
assert.equal(r.body.ok, true, 'should land on the consultant who is free');
assert.equal(moved.length, 3, 'same consultant first, then the consultants for that slot');
assert.equal(moved[2].staff_id, 'staff-B');

moved = [];
staffFree = 'nobody';
r = await call({ date: D2, slot: '4:30 PM', mobile: '9000000005', action: 'reschedule', staff_ids: ['staff-A'] });
assert.equal(r.code, 409);
assert.match(r.body.error, /not free at that time/);
staffFree = null;

// 9. Reschedule with nothing on record tells them to start again.
verify('9000000009');
r = await call({ date: D1, slot: '3:00 PM', mobile: '9000000009', action: 'reschedule' });
assert.equal(r.code, 409);
assert.match(r.body.error, /could not find your existing consultation/);

// 10. A booking already in the past never blocks a new one.
store.clear();
await dupes.rebuildDuplicateIndex([
  { customer_contact_no: '+919000000003', start_time: '01-Jan-2020 15:00:00', status: 'completed', booking_id: '#EN-1', service_id: 's' }
]);
assert.equal(await dupes.findUpcomingBooking('91', '9000000003'), null, 'past bookings must not block');

// 11. Cancelled bookings are dropped, so a rebook is clean.
store.clear();
await dupes.rebuildDuplicateIndex([
  { customer_contact_no: '+919000000004', start_time: `${D1} 15:00:00`, status: 'cancel', booking_id: '#EN-2', service_id: 's' },
  { customer_contact_no: '+919000000005', start_time: `${D1} 15:00:00`, status: 'upcoming', booking_id: '#EN-3', service_id: 's' }
]);
assert.equal(await dupes.findUpcomingBooking('91', '9000000004'), null, 'a cancelled booking must not block');
assert.equal((await dupes.findUpcomingBooking('91', '9000000005')).booking_id, 'EN-3');

// 12. A booking made on Zoho's own page blocks too, which is what Zoho's own
//     limit misses.
created = [];
r = await call({ date: D2, slot: '4:30 PM', mobile: '9000000005' });
assert.equal(r.code, 409);
assert.equal(created.length, 0);

// 13. Country code is part of the match: same digits, different country.
assert.equal(await dupes.findUpcomingBooking('971', '9000000005'), null, 'must not match across countries');

// 14. A different mobile is unaffected.
created = [];
r = await call({ date: D1, slot: '3:00 PM', mobile: '9000000006' });
assert.equal(r.body.ok, true);
assert.equal(created.length, 1);

// 15. If Redis cannot be read the booking still goes through.
redisDown = true;
assert.equal(await dupes.findUpcomingBooking('91', '9000000005'), null, 'no lookup, no block');
redisDown = false;

say('ALL PASSED');
process.exit(0);
