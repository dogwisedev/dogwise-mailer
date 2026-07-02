// api/campaigns.js — dashboard API. GET list / POST upsert one / DELETE one.
import { getCampaigns, saveCampaigns, storeConfigured } from '../lib/store.js';

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${process.env.ADMIN_PASSWORD}` && process.env.ADMIN_PASSWORD;
}

function validCampaign(c) {
  if (!c || typeof c.label !== 'string' || !c.label.trim()) return 'Campaign needs a name';
  if (!Array.isArray(c.steps) || c.steps.length === 0) return 'Campaign needs at least one email';
  if (c.sendAs && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.sendAs)) return 'Send-from must be a full email address (or blank for deal owner)';
  for (const [i, s] of c.steps.entries()) {
    if (!s.subject?.trim()) return `Email ${i + 1} needs a subject`;
    if (!s.body?.trim()) return `Email ${i + 1} needs a body`;
    if (i < c.steps.length - 1 && (!Number.isFinite(s.delayDaysAfter) || s.delayDaysAfter < 1)) {
      return `Email ${i + 1} needs a wait of at least 1 day before the next email`;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong password' });

  const campaigns = await getCampaigns();

  if (req.method === 'GET') {
    return res.status(200).json({ campaigns, storeConfigured: storeConfigured() });
  }

  if (req.method === 'POST') {
    const { key, campaign } = req.body || {};
    if (!key || !/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'Campaign key must be lowercase letters, numbers, underscores' });
    const problem = validCampaign(campaign);
    if (problem) return res.status(400).json({ error: problem });
    // Last step never has a delay
    campaign.steps[campaign.steps.length - 1].delayDaysAfter = null;
    campaigns[key] = campaign;
    await saveCampaigns(campaigns);
    return res.status(200).json({ ok: true, campaigns });
  }

  if (req.method === 'DELETE') {
    const { key } = req.body || {};
    if (key === 'welcome') return res.status(400).json({ error: 'The welcome email can be edited but not deleted' });
    if (!campaigns[key]) return res.status(404).json({ error: 'Campaign not found' });
    delete campaigns[key];
    await saveCampaigns(campaigns);
    return res.status(200).json({ ok: true, campaigns });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
