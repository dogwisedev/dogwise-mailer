// api/cron.js — the sweep. Runs every 30 min via vercel.json cron.
import { getCampaigns } from '../lib/store.js';
import { getDueContacts, buildOwnerMap, getContactLive, getWaitingContacts, getDealOwnerId, updateContact } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';
import { hasMailFrom } from '../lib/gmail.js';
import { logEvent, bumpStat, getLastSend, shouldReplyCheck } from '../lib/activity.js';
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
        // Search results can be stale — re-fetch live before acting
        const fresh = await getContactLive(contact.id);
        const r = await processContact(fresh, campaigns, ownerMap);
        if (r.status === 'sent') summary.sent++;
        else if (r.status === 'completed') { summary.completed++; if (r.detail) summary.sent++; }
        else if (r.status === 'skipped') summary.deferred++;
        else summary.errors.push({ email, error: r.detail });
      } catch (err) {
        summary.errors.push({ email, error: err.message });
      }
    }

    // ── Reply sweep: contacts waiting for a future step — did they reply in the meantime?
    summary.replied = 0;
    try {
      const waiting = await getWaitingContacts(100);
      for (const w of waiting) {
        try {
          if (!(await shouldReplyCheck(w.id, 4))) continue; // throttle: each contact checked at most every 4h
          const lastSend = await getLastSend(w.id);
          if (!lastSend) continue;
          const email = w.properties?.email;
          if (!email) continue;
          const ownerId = await getDealOwnerId(w.id);
          const owner = ownerId ? ownerMap[String(ownerId)] : null;
          if (!owner?.email) continue;
          const replied = await hasMailFrom(owner.email, email, lastSend);
          if (replied === true) {
            await updateContact(w.id, { dw_campaign: '', dw_next_send: '' });
            await logEvent({ type: 'replied', contact: email, campaign: w.properties?.dw_campaign, step: parseInt(w.properties?.dw_campaign_step || '0', 10) - 1 || undefined, sender: owner.email, detail: 'sequence stopped — reply detected by sweep' });
            await bumpStat(w.properties?.dw_campaign, 'replied');
            summary.replied++;
          }
        } catch { /* per-contact failures never break the sweep */ }
      }
    } catch (e) {
      summary.errors.push({ warn: `reply sweep: ${e.message}` });
    }

    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ fatal: err.message, ...summary });
  }
}
