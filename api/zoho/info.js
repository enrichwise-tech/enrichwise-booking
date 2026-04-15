/**
 * GET /api/zoho/info
 *
 * Discovery endpoint — lists workspaces, services, and staff in your Zoho Bookings
 * account. Call this once after deploying to verify the right IDs for:
 *   - Priority Wealth Session (for ≥ ₹1 Cr clients)
 *   - Discovery Call (for < ₹1 Cr clients)
 *
 * No auth on this endpoint for simplicity — remove or protect before going to prod.
 */
import { zohoGet } from './_client.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 1. Workspaces
    const wsRes = await zohoGet('/bookings/v1/json/workspaces');
    if (!wsRes.ok) {
      return res.status(wsRes.status || 500).json({
        stage: 'workspaces',
        error: wsRes.data
      });
    }
    const workspaces = wsRes.data?.response?.returnvalue?.data || [];

    // 2. For each workspace, fetch services
    const out = [];
    for (const ws of workspaces) {
      const wsId = ws.id || ws.workspace_id;
      const svcRes = await zohoGet('/bookings/v1/json/services', { workspace_id: wsId });
      const services = svcRes.ok
        ? (svcRes.data?.response?.returnvalue?.data || [])
        : [{ error: svcRes.data }];

      // 3. For each service, fetch staff
      const svcWithStaff = [];
      for (const svc of services) {
        const svcId = svc.id || svc.service_id;
        if (!svcId) { svcWithStaff.push(svc); continue; }
        const staffRes = await zohoGet('/bookings/v1/json/staff', { service_id: svcId });
        svcWithStaff.push({
          ...svc,
          staff: staffRes.ok ? (staffRes.data?.response?.returnvalue?.data || []) : { error: staffRes.data }
        });
      }

      out.push({
        workspace: ws,
        services: svcWithStaff
      });
    }

    return res.status(200).json({ ok: true, workspaces: out });
  } catch (err) {
    console.error('[zoho/info] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
