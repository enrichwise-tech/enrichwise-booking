// Run: node tests/event-counts-corpus.test.mjs
// Simulated Upstash. Checks the by=corpus mode of /api/event-counts returns
// counts and fixed labels only, and counts each person once, by first OTP day.
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_KV_REST_API_URL = 'http://redis.test';
process.env.UPSTASH_REDIS_KV_REST_API_TOKEN = 'x';
process.env.EVENT_COUNTS_KEY = 'k123';
console.error = () => {};

const DAY = 86400000;
const today = Date.now();
const iso = t => new Date(t).toISOString().slice(0, 10);
const store = new Map();
const push = (t, evt) => {
  const k = `events:${iso(t)}`;
  if (!store.has(k)) store.set(k, []);
  store.get(k).unshift(JSON.stringify({ ts: t, ...evt }));
};

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith('http://redis.test')) throw new Error('unexpected call: ' + url);
  const body = JSON.parse(init.body);
  const enc = new Headers(init.headers).get('upstash-encoding') === 'base64';
  const wrap = v => (enc && typeof v === 'string' ? Buffer.from(v).toString('base64') : (enc && Array.isArray(v) ? v.map(wrap) : v));
  const run = ([op, ...a]) => {
    if (String(op).toLowerCase() === 'lrange') return store.get(a[0]) || [];
    throw new Error('cmd ' + op);
  };
  if (url.endsWith('/pipeline')) return new Response(JSON.stringify(body.map(c => ({ result: wrap(run(c)) }))));
  return new Response(JSON.stringify({ result: wrap(run(body)) }));
};

const mod = await import('../api/event-counts.js');
const handler = mod.default;
const call = q => new Promise(resolve => {
  const out = { setHeader() {} };
  out.status = c => { out.code = c; return out; };
  out.json = b => { out.body = b; resolve(out); return out; };
  handler({ method: 'GET', query: q }, out);
});

const t0 = today - 2 * DAY;      // two days ago
const t1 = today - 1 * DAY;      // yesterday
const ev = (mobile, type, ts, corpus = '') => push(ts, { type, mobile, country_code: '91', corpus });

// A: books, picked Under 50 lakh. All on t0.
ev('9000000001', 'otp_sent', t0);
ev('9000000001', 'otp_verified', t0 + 1000);
ev('9000000001', 'corpus_selected', t0 + 2000, 'Under ₹50 lakh');
ev('9000000001', 'details_submitted', t0 + 3000, 'Under ₹50 lakh');
ev('9000000001', 'slot_picked', t0 + 4000, 'Under ₹50 lakh');
ev('9000000001', 'booking_created', t0 + 5000, 'Under ₹50 lakh');
// A again: resends the code. Still one person.
ev('9000000001', 'otp_sent', t0 + 6000);

// B: starts on t0, finishes on t1. Counted on t0.
ev('9000000002', 'otp_sent', t0 + 100);
ev('9000000002', 'otp_verified', t0 + 200);
ev('9000000002', 'corpus_selected', t1, '₹1 Cr – ₹5 Cr');
ev('9000000002', 'booking_created', t1 + 100, '₹1 Cr – ₹5 Cr');   // skipped steps still count as reached

// C: code never verified.
ev('9000000003', 'otp_sent', t1);

// D: changes their mind on amount; last pick wins. Old label still known.
ev('9000000004', 'otp_sent', t1);
ev('9000000004', 'otp_verified', t1 + 1);
ev('9000000004', 'corpus_selected', t1 + 2, 'Under ₹1 Cr');
ev('9000000004', 'corpus_selected', t1 + 3, '₹50 lakh – ₹1 Cr');
ev('9000000004', 'gbp_redirected', t1 + 4, '₹50 lakh – ₹1 Cr');

// E: someone typed rubbish into the log as a corpus. Must not leak out.
ev('9000000005', 'otp_sent', t1);
ev('9000000005', 'corpus_selected', t1 + 1, 'Rahul 9876543210');

// F: started before the window (20 days ago), carries on inside it. Left out.
ev('9000000006', 'otp_sent', today - 20 * DAY);
ev('9000000006', 'booking_created', t1, '₹5 Cr+');

// 1. Wrong key: nothing.
let r = await call({ key: 'nope', by: 'corpus' });
assert.equal(r.code, 404);

// 2. The default mode is unchanged.
r = await call({ key: 'k123', days: '3' });
assert.equal(r.code, 200);
assert.ok(r.body.days[iso(t0)].otp_sent >= 1, 'default mode still counts raw events');
assert.equal(r.body.by, undefined);

// 3. Corpus mode.
r = await call({ key: 'k123', days: '14', by: 'corpus' });
assert.equal(r.code, 200);
assert.equal(r.body.by, 'corpus');
assert.equal(r.body.window_days, 14);
const d0 = r.body.days[iso(t0)];
const d1 = r.body.days[iso(t1)];

// Day of first otp_sent: A and B on t0; C, D, E on t1; F nowhere.
assert.equal(d0.all.people, 2);
assert.equal(d1.all.people, 3);

// A once despite the resend; reached every step.
assert.equal(d0.by_corpus['Under ₹50 lakh'].people, 1);
assert.equal(d0.by_corpus['Under ₹50 lakh'].reached.booking_created, 1);
assert.equal(d0.by_corpus['Under ₹50 lakh'].furthest.booking_created, 1);

// B on t0 even though they booked on t1, and skipped steps count as reached.
assert.equal(d0.by_corpus['₹1 Cr – ₹5 Cr'].reached.details_submitted, 1);
assert.equal(d0.by_corpus['₹1 Cr – ₹5 Cr'].reached.booking_created, 1);
assert.equal(d0.all.reached.booking_created, 2);

// C stopped at the code, no amount picked.
assert.equal(d1.by_corpus.none.people, 1);
assert.equal(d1.by_corpus.none.furthest.otp_sent, 1);

// D: last pick wins, and the roadmap branch is counted.
assert.equal(d1.by_corpus['₹50 lakh – ₹1 Cr'].people, 1);
assert.equal(d1.by_corpus['₹50 lakh – ₹1 Cr'].reached.gbp_redirected, 1);
assert.equal(d1.by_corpus['Under ₹1 Cr'], undefined);

// E: rubbish label is "other", never echoed.
assert.equal(d1.by_corpus.other.people, 1);
assert.ok(!JSON.stringify(r.body).includes('Rahul'), 'free text must not leak');
assert.ok(!JSON.stringify(r.body).includes('987654'), 'no mobiles anywhere');
assert.ok(!JSON.stringify(r.body).includes('9000000'), 'no mobiles anywhere');

// F: started 20 days ago, outside a 14-day window, so not counted at all.
assert.ok(!Object.values(r.body.days).some(d => d.by_corpus['₹5 Cr+']), 'people who started before the window are left out');

// 4. Only integers and known labels anywhere in the body.
const allowed = new Set([...mod.KNOWN_CORPUS, 'none', 'other']);
for (const d of Object.values(r.body.days)) {
  for (const label of Object.keys(d.by_corpus)) assert.ok(allowed.has(label), 'unexpected label ' + label);
  for (const b of [d.all, ...Object.values(d.by_corpus)]) {
    assert.ok(Number.isInteger(b.people));
    for (const v of [...Object.values(b.reached), ...Object.values(b.furthest)]) assert.ok(Number.isInteger(v));
  }
}

// 5. The window is capped at 60.
r = await call({ key: 'k123', days: '500', by: 'corpus' });
assert.equal(r.body.window_days, 60);

console.log('ALL PASSED');
process.exit(0);
