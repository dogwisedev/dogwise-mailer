// api/enroll.js — bulk-enroll contacts into a campaign.
// POST { "campaign": "new_lead_welcome", "contactIds": ["123","456"], "startInDays": 0 }
// Called from the Chrome extension, a HubSpot workflow webhook, or curl.
import { getCampaigns } from '../lib/store.js';
import { updateContact, buildOwnerMap, getContactLive } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';
import { tierOf } from '../lib/allocate.js';

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

  // "Send now" uses the 0 sentinel, same as the HubSpot workflows: 0 sorts to the head of
  // the due queue. A Date.now() stamp sorts to the tail and is starved whenever the backlog
  // exceeds MAX_PER_RUN.
  //
  // Trade-off to know about: the SMS staleness guard in lib/process.js only applies when
  // due > 0, so a contact enrolled this way is exempt from it and will send however late
  // the queue reaches it. That is the opposite of what the guard exists for. Acceptable
  // while "send now" really means now; revisit if this endpoint is ever used for bulk
  // backfills.
  const firstSend = startInDays > 0 ? String(Date.now() + startInDays * 24 * 60 * 60 * 1000) : '0';
  const results = { enrolled: 0, errors: [] };

  for (const id of contactIds) {
    try {
      await updateContact(id, {
        dw_campaign: campaign,
        dw_campaign_step: '1',
        dw_next_send: firstSend
      });
      results.enrolled++;
    } catch (err) {
      results.errors.push({ id, error: err.message });
    }
  }

  // Straight campaigns send right now, in this request, rather than waiting for the
  // cron. Bounded so a big list can't run past the function limit; anything left over
  // is already due and the cron serves Straight before everything else.
  if (tierOf(campaigns[campaign]) === 'straight' && firstSend === '0' && results.enrolled) {
    const startedAt = Date.now();
    const ownerMap = await buildOwnerMap();
    results.sentNow = [];
    for (const id of contactIds) {
      if (Date.now() - startedAt > 60000) { results.note = 'rest left for the next cron run'; break; }
      try {
        const readAt = Date.now();
        const contact = await getContactLive(id);
        const r = await processContact(contact, campaigns, ownerMap, null, { readAt });
        results.sentNow.push({ id, status: r.status, detail: r.detail });
      } catch (err) {
        results.sentNow.push({ id, status: 'error', detail: err.message });
      }
    }
  }

  return res.status(200).json(results);
}
