/**
 * Fire-and-forget alert helper that posts a WhatsApp message via Periskope.
 *
 * Used on backend errors (WATI failures, Zoho failures, Redis failures) so
 * the team hears about broken bookings in real time instead of discovering
 * them hours later in Vercel logs.
 *
 * Env vars (all required — alert silently skips if any is missing):
 *   PERISKOPE_API_KEY        — bearer token from Periskope dashboard
 *   PERISKOPE_PHONE          — the phone number linked to your Periskope account (e.g. 919876543210)
 *   PERISKOPE_ALERT_CHAT_ID  — destination, e.g. "919876543210@c.us" for DM or "120...@g.us" for group
 */

const PERISKOPE_BASE = 'https://api.periskope.app/v1';

export async function sendAlert(subject, details = {}) {
  const apiKey = (process.env.PERISKOPE_API_KEY || '').trim();
  const phone = (process.env.PERISKOPE_PHONE || '').trim();
  const chatId = (process.env.PERISKOPE_ALERT_CHAT_ID || '').trim();

  // If not configured, silently skip — don't let alert plumbing block booking flow
  if (!apiKey || !phone || !chatId) {
    console.warn('[alert] Periskope env vars not set, skipping alert:', subject);
    return;
  }

  const lines = [`*[Enrichwise Booking]* ${subject}`];
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null || v === '') continue;
    const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300);
    lines.push(`• *${k}:* ${val}`);
  }
  lines.push(`\n_at ${new Date().toISOString()}_`);
  const message = lines.join('\n');

  try {
    // 10-second timeout so a slow alert never stalls the function
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);

    const res = await fetch(`${PERISKOPE_BASE}/message/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-phone': phone,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ chat_id: chatId, message }),
      signal: ctrl.signal
    });

    clearTimeout(tid);
    if (!res.ok) {
      console.error('[alert] Periskope send failed:', res.status, (await res.text()).slice(0, 200));
    }
  } catch (err) {
    console.error('[alert] Periskope send error:', err.name, err.message);
  }
}
