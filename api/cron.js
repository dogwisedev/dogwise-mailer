// api/cron.js — the sweep. Runs every 30 min via vercel.json cron.
import { getCampaigns } from '../lib/store.js';
import { getDueContacts, buildOwnerMap } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';
import { inSendWindow } from '../lib/util.js';

const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '40', 10);

export default async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET> automatically when CRON_SECRET is set.
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!inSendWindow()) {
    return res.status(200).json({ skipped: true, reason: 'outside send window' });
  }

  const summary = { sent: 0, deferred: 0, completed: 0, errors: [] };

  try {
    const [contacts, ownerMap, campaigns] = await Promise.all([getDueContacts(MAX_PER_RUN), buildOwnerMap(), getCampaigns()]);

    const senderCounts = {};
    for (const contact of contacts) {
      const email = contact.properties?.email || contact.id;
      try {
        const r = await processContact(contact, campaigns, ownerMap);
        if (r.status === 'sent') summary.sent++;
        else if (r.status === 'completed') { summary.completed++; if (r.detail) summary.sent++; }
        else if (r.status === 'skipped') summary.deferred++;
        else summary.errors.push({ email, error: r.detail });
      } catch (err) {
        summary.errors.push({ email, error: err.message });
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ fatal: err.message, ...summary });
  }
}
