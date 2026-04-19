/**
 * GET /api/admin/unmark-pushed?key=<ZOHO_INFO_KEY>&numbers=<comma-separated>
 *
 * One-time utility to remove phone numbers from the `crm:pushed` dedup set so
 * the next cron run will re-create their Lead in Zoho CRM. Use when a Lead
 * was manually deleted in CRM and you want it recreated.
 *
 * Example:
 *   /api/admin/unmark-pushed?key=...&numbers=918793420024,33682219008
 */
import { getRedis } from '../_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const expected = (process.env.ZOHO_INFO_KEY || '').trim();
  const provided = (req.query.key || '').trim();
  if (!expected || provided !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const raw = (req.query.numbers || '').trim();
  if (!raw) {
    return res.status(400).json({ error: 'Missing numbers query param (comma-separated, no leading +)' });
  }

  const numbers = raw.split(',').map(n => n.replace(/\D/g, '').trim()).filter(Boolean);
  if (!numbers.length) {
    return res.status(400).json({ error: 'No valid numbers found' });
  }

  try {
    const redis = getRedis();
    // @upstash/redis srem accepts spread args
    const removed = await redis.srem('crm:pushed', ...numbers);
    return res.status(200).json({
      ok: true,
      removed_count: removed,
      numbers
    });
  } catch (err) {
    console.error('[unmark-pushed] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
