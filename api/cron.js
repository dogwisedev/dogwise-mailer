// api/cron.js — the sweep. Runs every 30 min via vercel.json cron.
import { getCampaigns } from '../lib/store.js';
import { getDueContacts, buildOwnerMap, getContactLive, getWaitingContacts, getCompletedContacts, getDealOwnerId, updateContact } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';
import { hasMailFrom } from '../lib/gmail.js';
import { logEvent, bumpStat, getLastSend, shouldReplyCheck } from '../lib/activity.js';
// NOTE: the send window is no longer global — it's per-campaign and evaluated in each
// recipient's timezone inside processContact(). The old global gate has been removed so
// it can't block, say, a Colorado lead at 6pm ET across the whole run.

const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '40', 10);

export default async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET> automatically when CRON_SECRET is set.
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
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

    // ── Reply sweep:
    //   waiting contacts (future step pending) → reply cancels the sequence
    //   completed contacts (within 14 days of last send) → reply is logged for stats only
    summary.replied = 0;
    const REPLY_WINDOW_MS = 14 * 86400000;

    async function checkReply(rec, { unenroll }) {
      if (campaigns[rec.properties?.dw_campaign]?.type === 'checklist') return; // onboarding stops only when the checklist is done
      if (!(await shouldReplyCheck(rec.id, 4))) return; // each contact checked at most every 4h
      const lastSend = await getLastSend(rec.id);
      if (!lastSend) return;                                    // pre-tracking sends: no window, skip
      if (!unenroll && Date.now() - lastSend > REPLY_WINDOW_MS) return; // completed: stop watching after 14d
      const email = rec.properties?.email;
      if (!email) return;
      const ownerId = await getDealOwnerId(rec.id);
      const owner = ownerId ? ownerMap[String(ownerId)] : null;
      if (!owner?.email) return;
      const replied = await hasMailFrom(owner.email, email, lastSend);
      if (replied !== true) return;

      if (unenroll) await updateContact(rec.id, { dw_campaign: '', dw_next_send: '' });
      await logEvent({
        type: 'replied', contact: email, campaign: rec.properties?.dw_campaign,
        step: Math.max(1, parseInt(rec.properties?.dw_campaign_step || '2', 10) - 1), sender: owner.email,
        detail: unenroll ? 'sequence stopped — reply detected by sweep' : 'reply after sequence completed'
      });
      await bumpStat(rec.properties?.dw_campaign, 'replied');
      summary.replied++;
    }

    try {
      const [waiting, completed] = await Promise.all([getWaitingContacts(100), getCompletedContacts(100)]);
      for (const w of waiting)  { try { await checkReply(w, { unenroll: true  }); } catch { /* keep sweeping */ } }
      for (const d of completed) { try { await checkReply(d, { unenroll: false }); } catch { /* keep sweeping */ } }
    } catch (e) {
      summary.errors.push({ warn: `reply sweep: ${e.message}` });
    }

    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ fatal: err.message, ...summary });
  }
}
