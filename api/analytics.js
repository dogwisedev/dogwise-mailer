// api/analytics.js — aggregated read side for the dashboard charts.
//
//   GET /api/analytics?campaigns=welcome,ongoing&days=14
//
// Returns one block per campaign so the UI can render several funnels side by side for
// comparison. All figures come from lib/metrics.js counters, not the activity list, so
// they survive well beyond the 2,000-entry feed window.
import {
  campaignFunnel, campaignLinks, campaignHourOfDay, campaignTimeToOpen,
  metricsConfigured, dayRange
} from '../lib/metrics.js';
import { getCampaigns } from '../lib/store.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  if (!metricsConfigured()) return res.status(200).json({ configured: false, campaigns: {} });

  const days = Math.min(Math.max(parseInt(String(req.query.days || '14'), 10) || 14, 1), 90);

  try {
    const all = await getCampaigns();
    const requested = String(req.query.campaigns || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const keys = (requested.length ? requested : Object.keys(all)).filter(k => all[k]);

    const out = {};
    for (const key of keys) {
      const [funnel, links, hod, tto] = await Promise.all([
        campaignFunnel(key, days),
        campaignLinks(key),
        campaignHourOfDay(key),
        campaignTimeToOpen(key)
      ]);

      const steps = (all[key].steps || []).map((s, i) => {
        const m = funnel.steps[String(i + 1)] || {};
        const sent = m.sent || 0;
        return {
          step: i + 1,
          channel: s.channel === 'sms' ? 'sms' : 'email',
          subject: s.subject || '',
          sent,
          opened: m.opened || 0,
          openHits: m.open_hit || 0,
          clicked: m.clicked || 0,
          clickHits: m.click_hit || 0,
          replied: m.replied || 0,
          openRate: sent ? +(100 * (m.opened || 0) / sent).toFixed(1) : null,
          clickRate: sent ? +(100 * (m.clicked || 0) / sent).toFixed(1) : null,
          replyRate: sent ? +(100 * (m.replied || 0) / sent).toFixed(1) : null
        };
      });

      out[key] = {
        label: all[key].label || key,
        type: all[key].type || 'sequence',
        totals: funnel.totals,
        byDay: funnel.byDay,
        steps,
        links,
        hourOfDay: hod,
        timeToOpen: tto
      };
    }

    return res.status(200).json({ configured: true, days: dayRange(days), campaigns: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
