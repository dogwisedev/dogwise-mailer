// api/enroll.js — bulk-enroll contacts into a campaign.
// POST { "campaign": "new_lead_welcome", "contactIds": ["123","456"], "startInDays": 0 }
// Called from the Chrome extension, a HubSpot workflow webhook, or curl.
import { getCampaigns } from '../lib/store.js';
import { updateContact } from '../lib/hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { campaign, contactIds, startInDays = 0 } = req.body || {};
  const campaigns = await getCampaigns();
  if (!campaigns[campaign]) return res.status(400).json({ error: `unknown campaign "${campaign}"`, available: Object.keys(campaigns) });
  if (!Array.isArray(contactIds) || contactIds.length === 0) return res.status(400).json({ error: 'contactIds array required' });

  const firstSend = Date.now() + startInDays * 24 * 60 * 60 * 1000;
  const results = { enrolled: 0, errors: [] };

  for (const id of contactIds) {
    try {
      await updateContact(id, {
        dw_campaign: campaign,
        dw_campaign_step: '1',
        dw_next_send: String(firstSend)
      });
      results.enrolled++;
    } catch (err) {
      results.errors.push({ id, error: err.message });
    }
  }

  return res.status(200).json(results);
}
