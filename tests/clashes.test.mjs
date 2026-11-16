// Run: npm install && node tests/clashes.test.mjs
// Simulated Zoho. Checks what the daily double-booking check would cancel.
// A real POST to updateappointment would cancel a REAL client appointment and
// send them Zoho's cancellation email, so nothing here reaches Zoho.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZOHO_CLIENT_ID = 'id';
process.env.ZOHO_CLIENT_SECRET = 'secret';
process.env.ZOHO_REFRESH_TOKEN = 'refresh';
console.error = () => {}; console.warn = () => {};
const say = console.log;
console.log = () => {};

const store = new Map([['zoho:access_token', 'tok']]);
let cancelled = [];
let failNext = false;

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
  if (url.startsWith('http://redis.test')) {
    const body = JSON.parse(init.body);
    const enc = new Headers(init.headers).get('upstash-encoding') === 'base64';
    const wrap = v => (enc && typeof v === 'string' ? Buffer.from(v).toString('base64') : v);
    const run = ([op, ...a]) => {
      const O = String(op).toLowerCase();
      if (O === 'get') return store.has(a[0]) ? store.get(a[0]) : null;
      if (O === 'set') { store.set(a[0], a[1]); return 'OK'; }
      if (O === 'del') return store.delete(a[0]) ? 1 : 0;
      return 1;
    };
    if (url.endsWith('/pipeline')) return J(body.map(c => ({ result: wrap(run(c)) })));
    return J({ result: wrap(run(body)) });
  }
  if (url.includes('/oauth/v2/token')) return J({ access_token: 'tok', expires_in: 3600 });
  if (url.includes('updateappointment')) {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('action'), 'cancel', 'only ever cancels');
    if (failNext) { failNext = false; return J({ response: { status: 'failure', returnvalue: { message: 'Already cancelled' } } }); }
    cancelled.push(form.get('booking_id'));
    return J({ response: { status: 'success', returnvalue: { booking_id: form.get('booking_id'), status: 'cancel' } } });
  }
  throw new Error('unexpected call: ' + url);
};

const { findClashes, cancelClashes, cancelBooking } = await import('../api/zoho/_clashes.js');

const b = (id, phone, start, staff, bookedOn, status = 'upcoming') => ({
  booking_id: id, customer_contact_no: phone, customer_name: 'Someone',
  start_time: start, staff_name: staff, booked_on: bookedOn, status
});

// The two real cases from 2026-11-16, plus the ones that must be left alone.
const diary = [
  // Same minute, two consultants: a genuine clash.
  b('#EN-13197', '+919310211241', '17-Nov-2026 17:15:00', 'Amit Halder',   '2026-11-08 16:25:17'),
  b('#EN-13198', '+919310211241', '17-Nov-2026 17:15:00', 'Vicky Singh',   '2026-11-08 16:59:06'),
  b('#EN-13406', '+917977228540', '20-Nov-2026 11:15:00', 'Plato Lobo',    '2026-11-13 12:19:06'),
  b('#EN-13407', '+917977228540', '20-Nov-2026 11:15:00', 'Jyoti Burungale', '2026-11-13 12:21:10'),
  // Same day, different times: could be deliberate, so report only.
  b('#EN-13389', '+919719732300', '19-Nov-2026 16:30:00', 'Plato Lobo',    '2026-11-12 23:06:57'),
  b('#EN-13390', '+919719732300', '19-Nov-2026 15:45:00', 'Pradeep Devadiga', '2026-11-12 23:33:12'),
  // Different days: normal, ignore entirely.
  b('#EN-13075', '+971501889688', '16-Nov-2026 12:00:00', 'Plato Lobo',    '2026-11-05 07:40:16'),
  b('#EN-13409', '+971501889688', '19-Nov-2026 15:00:00', 'Yash Purecha',  '2026-11-13 12:29:53'),
  // Already cancelled: must never count or be cancelled again.
  b('#EN-13500', '+919000000001', '18-Nov-2026 15:00:00', 'Amit Halder',   '2026-11-10 10:00:00', 'cancel'),
  b('#EN-13501', '+919000000001', '18-Nov-2026 15:00:00', 'Vicky Singh',   '2026-11-10 10:05:00')
];

const { clashes, sameDay } = findClashes(diary);

assert.equal(clashes.length, 2, 'only the same-minute pairs are clashes');
const byCancel = Object.fromEntries(clashes.map(c => [c.cancel.booking_id, c]));
assert.ok(byCancel['EN-13198'], 'the later of Deepti pair is the one to cancel');
assert.equal(byCancel['EN-13198'].keep.booking_id, 'EN-13197');
assert.ok(byCancel['EN-13407'], 'the later of Ajay pair is the one to cancel');
assert.equal(byCancel['EN-13407'].keep.booking_id, 'EN-13406');
// The one booked first is always kept.
for (const c of clashes) assert.ok(c.keep.booked_on <= c.cancel.booked_on, 'keeps the earlier booking');

assert.equal(sameDay.length, 1, 'back-to-back on one day is reported, not cancelled');
assert.equal(sameDay[0].bookings.length, 2);
assert.ok(!clashes.some(c => c.cancel.booking_id === 'EN-13390'), 'must not cancel a different-time booking');
assert.ok(!clashes.some(c => ['EN-13075', 'EN-13409'].includes(c.cancel.booking_id)), 'different days are not duplicates');
assert.ok(!clashes.some(c => c.cancel.booking_id === 'EN-13501'), 'a cancelled booking does not make a clash');

// Reporting changes nothing.
let out = await cancelClashes(clashes, { apply: false });
assert.equal(out.applied, false);
assert.equal(cancelled.length, 0, 'report mode must not touch Zoho');
assert.equal(out.skipped, 2);

// Applying cancels exactly the later booking of each clash.
out = await cancelClashes(clashes, { apply: true });
assert.equal(out.applied, true);
assert.deepEqual(cancelled.sort(), ['#EN-13198', '#EN-13407']);
assert.equal(out.cancelled.length, 2);
assert.equal(out.failed.length, 0);

// A Zoho failure is reported, not silently swallowed.
cancelled = []; failNext = true;
out = await cancelClashes([clashes[0]], { apply: true });
assert.equal(out.cancelled.length, 0);
assert.equal(out.failed.length, 1);
assert.match(out.failed[0].error, /Already cancelled/);

// A big pile means the detection changed, not the diary: cancel nothing.
cancelled = [];
const many = Array.from({ length: 6 }, (_, i) => ({
  ...clashes[0], cancel: { ...clashes[0].cancel, booking_id: 'EN-' + i }
}));
out = await cancelClashes(many, { apply: true });
assert.equal(out.applied, false);
assert.equal(cancelled.length, 0, 'must refuse a run that would cancel too many');
assert.match(out.refused, /more than 5/);

// Nothing in the diary, nothing to do.
assert.deepEqual(findClashes([]), { clashes: [], sameDay: [] });
assert.deepEqual(findClashes([b('#EN-1', '+919000000002', '18-Nov-2026 15:00:00', 'Amit', '2026-11-10 10:00:00')]),
  { clashes: [], sameDay: [] });

// Cancel only ever sends action=cancel (asserted in the mock above).
cancelled = [];
const one = await cancelBooking('EN-777');
assert.equal(one.ok, true);
assert.deepEqual(cancelled, ['#EN-777'], 'adds the # Zoho expects');

say('ALL PASSED');
process.exit(0);
