// lib/process.js — sends the due step for one contact. Shared by cron sweep and instant webhook.
import { getDealOwnerId, updateContact, logEmailToTimeline } from './hubspot.js';
import { sendAsOwner, hasMailFrom } from './gmail.js';
import { personalize, renderHtml, toPlainText, daysFromNow } from './util.js';
import { logEvent, rememberSend, rememberLastSend, getLastSend, bumpStat } from './activity.js';

function appUrl() {
  return process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://dogwise-mailer.vercel.app');
}

/**
 * Process a single contact record (shape: { id, properties }).
 * Returns { status: 'sent'|'completed'|'skipped'|'replied'|'error', detail? }
 */
export async function processContact(contact, campaigns, ownerMap) {
  const p = contact.properties || {};
  const email = p.email;
  if (!email) return { status: 'error', detail: 'contact has no email' };
  if (String(p.hs_email_optout) === 'true') return { status: 'skipped', detail: 'opted out' };
  if (!p.dw_campaign) return { status: 'skipped', detail: 'no campaign set' };

  // Guard against stale search results / duplicate triggers: only send if genuinely due NOW.
  const due = parseInt(p.dw_next_send || '', 10);
  if (isNaN(due) || due > Date.now()) return { status: 'skipped', detail: 'not due (stale or future dw_next_send)' };

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

  const base = { contact: email, campaign: p.dw_campaign, step: stepIndex + 1, sender: owner.email };

  // ── Reply detection: if the contact has emailed the owner since our last send, stop the sequence.
  const lastSend = await getLastSend(contact.id);
  if (lastSend) {
    const replied = await hasMailFrom(owner.email, email, lastSend);
    if (replied === true) {
      await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
      await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact emailed the owner' });
      await bumpStat(base.campaign, 'replied');
      return { status: 'replied', detail: `${email} replied to ${owner.email}; unenrolled` };
    }
    // replied === null → can't check (scope missing / transient) → proceed with the send
  }

  const vars = {
    firstname: p.firstname,
    lastname: p.lastname,
    sender_firstname: owner.firstName,
    sender_lastname: owner.lastName
  };
  const subject = personalize(step.subject, vars);
  const rawBody = personalize(step.body, vars);

  // Open-tracking pixel (id is opaque; metadata lives in Redis, not the URL)
  const sendId = `${contact.id}.${stepIndex + 1}.${Date.now().toString(36)}`;
  const html = renderHtml(rawBody) + `<img src="${appUrl()}/api/px?e=${sendId}" width="1" height="1" alt="" style="display:none">`;

  await sendAsOwner({
    senderEmail: owner.email,
    senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
    to: email,
    subject,
    body: toPlainText(rawBody),
    html
  });

  await rememberSend(sendId, base);
  await rememberLastSend(contact.id);
  await logEvent({ type: 'sent', ...base, subject });
  await bumpStat(base.campaign, 'sent');

  try {
    await logEmailToTimeline({ contactId: contact.id, ownerId, subject, body: toPlainText(rawBody), campaign: p.dw_campaign, step: stepIndex + 1 });
  } catch { /* timeline logging is non-fatal */ }

  const isLast = stepIndex + 1 >= campaign.steps.length;
  await updateContact(contact.id, isLast || step.delayDaysAfter == null
    ? { dw_next_send: '', dw_campaign_step: String(stepIndex + 2) }
    : { dw_next_send: String(daysFromNow(step.delayDaysAfter)), dw_campaign_step: String(stepIndex + 2) });

  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };
}
