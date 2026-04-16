/**
 * GET /api/zoho/test-crm?key=<ZOHO_INFO_KEY>
 *
 * Debug endpoint — tries to create a test Lead in Zoho CRM and returns
 * the full raw response so you can see exactly what Zoho accepted or rejected.
 *
 * Does NOT swallow errors — shows everything. Protected by the same info key.
 *
 * After verifying, delete the test Lead from Zoho CRM Leads module manually.
 */
import { upsertFunnelLead, findLeadByPhone } from './_crm.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = (process.env.ZOHO_INFO_KEY || '').trim();
  const provided = (req.query.key || '').trim();
  if (!expected || provided !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const testPhone = '+910000000001';

  try {
    console.log('[test-crm] Step 1: searching for existing lead with phone', testPhone);
    const existing = await findLeadByPhone(testPhone);
    console.log('[test-crm] Step 2: existing =', JSON.stringify(existing)?.slice(0, 300));

    console.log('[test-crm] Step 3: calling upsertFunnelLead...');
    const result = await upsertFunnelLead({
      stage: 'otp_verified',
      mobile: '0000000001',
      country_code: '91',
      name: 'Test CRM Lead',
      email: 'test-crm@enrichwise.local'
    });

    console.log('[test-crm] Step 4: result =', JSON.stringify(result)?.slice(0, 600));

    return res.status(200).json({
      ok: true,
      message: 'Test lead upsert completed. Check Zoho CRM Leads module for "Test CRM Lead" with phone +910000000001. Delete it manually after verification.',
      existing_found: !!existing,
      result
    });
  } catch (err) {
    console.error('[test-crm] error:', err.message, err.stack?.slice(0, 500));
    return res.status(500).json({
      ok: false,
      error: err.message,
      hint: 'Check that ZOHO_REFRESH_TOKEN has ZohoCRM.modules.leads.CREATE scope. Also check Vercel runtime logs for [test-crm] entries.'
    });
  }
}
