// lib/process.js — sends the due step for one contact. Shared by cron sweep and instant webhook.
import { getDealOwnerId, updateContact, logEmailToTimeline } from './hubspot.js';
import { sendAsOwner } from './gmail.js';
import { personalize, renderHtml, toPlainText, daysFromNow } from './util.js';

/**
 * Process a single contact record (shape: { id, properties }).
 * Returns { status: 'sent'|'completed'|'skipped'|'error', detail? }
 */
export async function processContact(contact, campaigns, ownerMap) {
  const p = contact.properties || {};
  const email = p.email;
  if (!email) return { status: 'error', detail: 'contact has no email' };
  if (String(p.hs_email_optout) === 'true') return { status: 'skipped', detail: 'opted out' };
  if (!p.dw_campaign) return { status: 'skipped', detail: 'no campaign set' };

  const campaign = campaigns[p.dw_campaign];
  if (!campaign) {
    await updateContact(contact.id, { dw_next_send: '' });
    return { status: 'error', detail: `unknown campaign "${p.dw_campaign}"` };
  }

  const stepIndex = Math.max(1, parseInt(p.dw_campaign_step || '1', 10)) - 1;
  const step = campaign.steps[stepIndex];
  if (!step) {
    await updateContact(contact.id, { dw_next_send: '', dw_campaign_step: String(campaign.steps.length) });
    return { status: 'completed' };
  }

  const ownerId = await getDealOwnerId(contact.id);
  const owner = ownerId ? ownerMap[String(ownerId)] : null;
  if (!owner?.email) return { status: 'error', detail: `no deal owner resolvable (ownerId: ${ownerId})` };

  const vars = {
    firstname: p.firstname,
    lastname: p.lastname,
    sender_firstname: owner.firstName,
    sender_lastname: owner.lastName
  };
  const subject = personalize(step.subject, vars);
  const rawBody = personalize(step.body, vars);

  await sendAsOwner({
    senderEmail: owner.email,
    senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
    to: email,
    subject,
    body: toPlainText(rawBody),
    html: renderHtml(rawBody)
  });

  try {
    await logEmailToTimeline({ contactId: contact.id, ownerId, subject, body: toPlainText(rawBody), campaign: p.dw_campaign, step: stepIndex + 1 });
  } catch { /* timeline logging is non-fatal */ }

  const isLast = stepIndex + 1 >= campaign.steps.length;
  await updateContact(contact.id, isLast || step.delayDaysAfter == null
    ? { dw_next_send: '', dw_campaign_step: String(stepIndex + 2) }
    : { dw_next_send: String(daysFromNow(step.delayDaysAfter)), dw_campaign_step: String(stepIndex + 2) });

  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };
}
