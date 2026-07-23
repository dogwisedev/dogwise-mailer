// lib/process.js — sends the due step for one contact. Shared by the cron sweep and the
// instant webhook. A step is either EMAIL (subject + body, sent as the deal owner via
// Gmail) or SMS (body only, sent via OpenPhone). Per-step day scope and the per-campaign
// send window are both evaluated in the RECIPIENT'S timezone (resolved from their ZIP).
import { getDealOwnerId, updateContact, logEmailToTimeline, getLoggedCallCount } from './hubspot.js';
import { sendAsOwner, hasMailFrom } from './gmail.js';
import { sendSms, hasInboundSince } from './sms.js';
import { personalize, renderHtml, toPlainText, daysFromNow } from './util.js';
import { bookingLinkFor, smsNumberFor } from './settings.js';
import { resolveRegion, canSendNow } from './region.js';
import { logEvent, rememberSend, rememberLastSend, getLastSend, bumpStat } from './activity.js';
import { processChecklist } from './checklist.js';

function appUrl() {
  return process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://dogwise-mailer.vercel.app');
}

/**
 * Process a single contact record ({ id, properties }).
 * Returns { status: 'sent'|'completed'|'skipped'|'replied'|'error', detail? }
 */
export async function processContact(contact, campaigns, ownerMap) {
  const p = contact.properties || {};
  const email = p.email;
  if (String(p.hs_email_optout) === 'true') return { status: 'skipped', detail: 'opted out' };
  if (!p.dw_campaign) return { status: 'skipped', detail: 'no campaign set' };

  // Only act if genuinely due NOW (guards against stale search results / duplicate triggers).
  const due = parseInt(p.dw_next_send || '', 10);
  if (isNaN(due) || due > Date.now()) return { status: 'skipped', detail: 'not due (stale or future dw_next_send)' };

  const campaign = campaigns[p.dw_campaign];
  if (!campaign) {
    await updateContact(contact.id, { dw_next_send: '' });
    return { status: 'error', detail: `unknown campaign "${p.dw_campaign}"` };
  }

  if (campaign.type === 'checklist') return processChecklist(contact, campaign, ownerMap);

  const stepIndex = Math.max(1, parseInt(p.dw_campaign_step || '1', 10)) - 1;
  const step = campaign.steps[stepIndex];
  if (!step) {
    await updateContact(contact.id, { dw_next_send: '', dw_campaign_step: String(campaign.steps.length) });
    return { status: 'completed' };
  }

  const channel = step.channel === 'sms' ? 'sms' : 'email';
  if (channel === 'email' && !email) return { status: 'error', detail: 'contact has no email' };
  if (channel === 'sms' && !p.phone)  return { status: 'error', detail: 'contact has no phone (SMS step)' };

  // ── Sender: campaign-level override wins; otherwise the deal owner. ──
  let owner = null, ownerId = null;
  if (campaign.sendAs) {
    const match = Object.entries(ownerMap).find(([, o]) => o.email?.toLowerCase() === campaign.sendAs.toLowerCase());
    if (match) { ownerId = match[0]; owner = match[1]; }
    else owner = { email: campaign.sendAs, firstName: campaign.sendAsName || '', lastName: '' };
  } else {
    ownerId = await getDealOwnerId(contact.id);
    owner = ownerId ? ownerMap[String(ownerId)] : null;
    if (!owner?.email) return { status: 'error', detail: `no deal owner resolvable (ownerId: ${ownerId})` };
  }

  const base = { contact: email || p.phone, campaign: p.dw_campaign, step: stepIndex + 1, sender: owner.email, channel };

  // ── Region (recipient timezone) — resolve once, then persist so we don't recompute each pass. ──
  const { region, stamped } = await resolveRegion({ stampedRegion: p.lead_region, zip: p.zip_code });
  if (!stamped) { try { await updateContact(contact.id, { lead_region: region }); } catch { /* non-fatal */ } }

  // ── Send window + allowed days, in the lead's local time. Outside → DEFER (leave dw_next_send
  //    untouched; the 5-min cron retries until the window/day opens). No status is written. ──
  const gate = canSendNow(region, campaign.window, step.days);
  if (!gate.ok) return { status: 'skipped', detail: `deferred — ${gate.reason}` };

  // ── Stop-if-called: a rep has logged a call, so back off the whole sequence. ──
  if (campaign.stopIfCalled) {
    const calls = await getLoggedCallCount(contact.id);
    if (calls > 0) {
      await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
      await logEvent({ type: 'skipped', ...base, detail: `stopped — ${calls} logged call(s), a rep took over` });
      return { status: 'completed', detail: 'stopped — rep logged a call' };
    }
  }

  // Which numbers/replies matter: only touch OpenPhone if this campaign actually uses SMS.
  const campaignHasSms = campaign.steps.some(s => s.channel === 'sms');
  const smsNumberId = (channel === 'sms' || (campaignHasSms && ownerId)) ? await smsNumberFor(ownerId, region) : '';

  // ── Reply detection: if the lead has come back to us since our last send, stop the sequence. ──
  const lastSend = await getLastSend(contact.id);
  if (lastSend) {
    if (email) {
      const repliedEmail = await hasMailFrom(owner.email, email, lastSend);
      if (repliedEmail === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact emailed the owner' });
        await bumpStat(base.campaign, 'replied');
        return { status: 'replied', detail: `${email} replied to ${owner.email}; unenrolled` };
      }
    }
    if (campaignHasSms && smsNumberId && p.phone) {
      const repliedSms = await hasInboundSince({ phoneNumberId: smsNumberId, contactPhone: p.phone, sinceMs: lastSend });
      if (repliedSms === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact texted back' });
        await bumpStat(base.campaign, 'replied');
        return { status: 'replied', detail: `${p.phone} texted back; unenrolled` };
      }
    }
    // null from either check (can't verify) → proceed with the send
  }

   const vars = {
    firstname: p.firstname,
    lastname: p.lastname,
    email: email,
    sender_firstname: owner.firstName,
    sender_lastname: owner.lastName,
    sender_booking_link: await bookingLinkFor(owner.email)
  };

  const isLast = stepIndex + 1 >= campaign.steps.length;

  // Fixed advance function
  const advance = async () => {
    const nextStepNum = stepIndex + 2;
    if (isLast || step.delayDaysAfter == null) {
      return updateContact(contact.id, { 
        dw_next_send: '', 
        dw_campaign_step: String(nextStepNum) 
      });
    } else {
      const delayMs = (step.delayDaysAfter || 0) * 24 * 60 * 60 * 1000;
      const nextTime = Date.now() + delayMs;
      return updateContact(contact.id, { 
        dw_next_send: String(nextTime), 
        dw_campaign_step: String(nextStepNum) 
      });
    }
  };

  // ═══════════════ SMS ═══════════════
  if (channel === 'sms') {
    if (!ownerId) return { status: 'error', detail: 'SMS step needs a deal owner (no sendAs number map)' };
    if (!smsNumberId) return { status: 'error', detail: `no OpenPhone number for owner ${ownerId} / ${region}` };
    const content = personalize(step.body, vars);
    const r = await sendSms({ from: smsNumberId, to: p.phone, content });
    if (!r.ok) {
      await logEvent({ type: 'error', ...base, detail: r.error });
      return { status: 'error', detail: r.error };
    }
    await rememberLastSend(contact.id);
    await logEvent({ type: 'sent', ...base, detail: `SMS via ${region} number` });
    await bumpStat(base.campaign, 'sent');
    await advance();
    return { status: isLast ? 'completed' : 'sent', detail: `SMS step ${stepIndex + 1} → ${p.phone} (${region})` };
  }

  // ═══════════════ EMAIL ═══════════════
  const subject = personalize(step.subject, vars);
  const rawBody = personalize(step.body, vars);
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

  await advance();   // ← Important: now properly awaited for email too

  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };

  // ═══════════════ EMAIL ═══════════════ (unchanged behaviour + open-tracking pixel)
  const subject = personalize(step.subject, vars);
  const rawBody = personalize(step.body, vars);
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

  await advance();
  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };
}
