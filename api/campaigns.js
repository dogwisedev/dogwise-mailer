// api/campaigns.js — dashboard API. GET list (+ folders) / POST upsert one / DELETE one.
import { getCampaigns, saveCampaigns, storeConfigured, getFolders } from '../lib/store.js';

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${process.env.ADMIN_PASSWORD}` && process.env.ADMIN_PASSWORD;
}

function validCampaign(c) {
  if (!c || typeof c.label !== 'string' || !c.label.trim()) return 'Campaign needs a name';

  if (c.type === 'checklist') {
    if (!c.firstEmail?.subject?.trim() || !c.firstEmail?.body?.trim()) return 'Checklist campaign needs the first email (subject + body)';
    for (const [i, item] of (c.customItems || []).entries()) {
      if (!item.label?.trim()) return `Custom check item ${i + 1} needs a name`;
      if (!/^[a-z0-9_]+$/.test(item.property || '')) return `Custom check item "${item.label}": deal property internal name must be lowercase letters, numbers, underscores`;
      if ((item.mode === 'equals' || item.mode === 'not_contains') && !String(item.value ?? '').trim()) return `Custom check item "${item.label}" needs a value for its rule`;
      if (!item.block?.trim()) return `Custom check item "${item.label}" needs email text`;
    }
    return null; // blocks/intros may be filled iteratively
  }

  if (!Array.isArray(c.steps) || c.steps.length === 0) return 'Campaign needs at least one step';
  if (c.sendAs && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.sendAs)) return 'Send-from must be a full email address (or blank for deal owner)';

  // Per-sequence send window (optional; omitted => 9–16 in the recipient's timezone).
  if (c.window) {
    const { startHour, endHour } = c.window;
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
      return 'Send window must be whole hours with start before end (e.g. 9 to 16)';
    }
  }

  for (const [i, s] of c.steps.entries()) {
    const channel = s.channel === 'sms' ? 'sms' : 'email';
    const n = i + 1;
    if (!s.body?.trim()) return `Step ${n} needs ${channel === 'sms' ? 'a message' : 'a body'}`;
    if (channel === 'email' && !s.subject?.trim()) return `Email step ${n} needs a subject`;
    if (s.days && !s.days.weekday && !s.days.weekend) return `Step ${n}: pick at least one of weekdays / weekends`;
    
    // CHANGED: Allow 0 or decimals (waitDaysAfter < 0 instead of < 1)
    if (i < c.steps.length - 1 && (!Number.isFinite(s.delayDaysAfter) || s.delayDaysAfter < 0)) {
      return `Step ${n} wait time cannot be negative`;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong password' });

  const campaigns = await getCampaigns();

  if (req.method === 'GET') {
    const folders = await getFolders();
    return res.status(200).json({ campaigns, folders, storeConfigured: storeConfigured() });
  }

  if (req.method === 'POST') {
    const { key, campaign } = req.body || {};
    if (!key || !/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'Campaign key must be lowercase letters, numbers, underscores' });
    const problem = validCampaign(campaign);
    if (problem) return res.status(400).json({ error: problem });
    // Last step never has a delay (linear campaigns only)
    if (campaign.type !== 'checklist') campaign.steps[campaign.steps.length - 1].delayDaysAfter = null;
    campaigns[key] = campaign;
    await saveCampaigns(campaigns);
    return res.status(200).json({ ok: true, campaigns });
  }

  if (req.method === 'DELETE') {
    const { key } = req.body || {};
    if (key === 'welcome') return res.status(400).json({ error: 'The welcome email can be edited but not deleted' });
    if (campaigns[key]?.type === 'checklist') return res.status(400).json({ error: 'Checklist campaigns can be edited but not deleted' });
    if (!campaigns[key]) return res.status(404).json({ error: 'Campaign not found' });
    delete campaigns[key];
    await saveCampaigns(campaigns);
    return res.status(200).json({ ok: true, campaigns });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
