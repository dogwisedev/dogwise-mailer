// api/cron.js — the sweep. Runs every 30 min via vercel.json cron.
import { getCampaigns } from '../lib/store.js';
import { getDueContacts, getDealOwnerId, buildOwnerMap, updateContact, logEmailToTimeline } from '../lib/hubspot.js';
import { sendAsOwner } from '../lib/gmail.js';
import { personalize, inSendWindow, daysFromNow, renderHtml, toPlainText } from '../lib/util.js';

const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '40', 10);
const MAX_PER_SENDER_PER_RUN = parseInt(process.env.MAX_PER_SENDER_PER_RUN || '15', 10);

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
  const senderCounts = {};

  try {
    const [contacts, ownerMap, campaigns] = await Promise.all([getDueContacts(MAX_PER_RUN), buildOwnerMap(), getCampaigns()]);

    for (const contact of contacts) {
      const p = contact.properties;
      const email = p.email;
      try {
        if (!email) throw new Error('contact has no email');

        const campaign = campaigns[p.dw_campaign];
        if (!campaign) {
          // Unknown campaign — clear so it stops matching, flag in summary
          await updateContact(contact.id, { dw_next_send: '' });
          throw new Error(`unknown campaign "${p.dw_campaign}"`);
        }

        const stepIndex = Math.max(1, parseInt(p.dw_campaign_step || '1', 10)) - 1;
        const step = campaign.steps[stepIndex];
        if (!step) {
          // Past the last step — mark complete
          await updateContact(contact.id, { dw_next_send: '', dw_campaign_step: String(campaign.steps.length) });
          summary.completed++;
          continue;
        }

        // Resolve DEAL owner (not contact owner)
        const ownerId = await getDealOwnerId(contact.id);
        const owner = ownerId ? ownerMap[String(ownerId)] : null;
        if (!owner?.email) throw new Error(`no deal owner resolvable (ownerId: ${ownerId})`);

        // Per-sender cap: defer to next run rather than skip
        senderCounts[owner.email] = senderCounts[owner.email] || 0;
        if (senderCounts[owner.email] >= MAX_PER_SENDER_PER_RUN) {
          summary.deferred++;
          continue; // dw_next_send untouched → picked up next run
        }

        const vars = {
          firstname: p.firstname,
          lastname: p.lastname,
          sender_firstname: owner.firstName,
          sender_lastname: owner.lastName
        };
        const subject = personalize(step.subject, vars);
        const rawBody = personalize(step.body, vars);
        const body = toPlainText(rawBody);
        const html = renderHtml(rawBody);

        await sendAsOwner({
          senderEmail: owner.email,
          senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
          to: email,
          subject,
          body,
          html
        });
        senderCounts[owner.email]++;

        // Log to HubSpot timeline (non-fatal if it fails)
        try {
          await logEmailToTimeline({
            contactId: contact.id, ownerId, subject, body,
            campaign: p.dw_campaign, step: stepIndex + 1
          });
        } catch (e) {
          summary.errors.push({ email, warn: `timeline log failed: ${e.message}` });
        }

        // Advance the sequence
        const isLast = stepIndex + 1 >= campaign.steps.length;
        const next = isLast || step.delayDaysAfter == null
          ? { dw_next_send: '', dw_campaign_step: String(stepIndex + 2) }
          : { dw_next_send: String(daysFromNow(step.delayDaysAfter)), dw_campaign_step: String(stepIndex + 2) };
        await updateContact(contact.id, next);

        if (isLast) summary.completed++;
        summary.sent++;
      } catch (err) {
        summary.errors.push({ email: email || contact.id, error: err.message });
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ fatal: err.message, ...summary });
  }
}
