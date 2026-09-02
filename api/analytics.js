// api/analytics.js — aggregated read side for the dashboard charts.
//
//   GET /api/analytics?campaigns=welcome,ongoing&days=14
//
// Returns one block per campaign so the UI can render several funnels side by side for
// comparison. All figures come from lib/metrics.js counters, not the activity list, so
// they survive well beyond the 2,000-entry feed window.
//
// The actual aggregation now lives in lib/analyticsCore.js, shared with api/mcp.js's
// get_analytics tool, so the dashboard and Claude always see the same numbers.
import { buildCampaignAnalytics } from '../lib/analyticsCore.js';
import { dayRange } from '../lib/metrics.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const days = Math.min(Math.max(parseInt(String(req.query.days || '14'), 10) || 14, 1), 90);

  try {
    const requested = String(req.query.campaigns || '').split(',').map(s => s.trim()).filter(Boolean);
    const { configured, campaigns } = await buildCampaignAnalytics(requested, days);
    if (!configured) return res.status(200).json({ configured: false, campaigns: {} });
    return res.status(200).json({ configured: true, days: dayRange(days), campaigns });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
