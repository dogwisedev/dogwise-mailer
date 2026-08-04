// lib/process.js — sends the due step for one contact. Shared by the cron sweep and the
// instant webhook. A step is either EMAIL (subject + body, sent as the deal owner via
// Gmail) or SMS (body only, sent via OpenPhone). Per-step day scope and the per-campaign
// send window are both evaluated in the RECIPIENT'S timezone (resolved from their ZIP).
import { getDealOwnerId, getOwnerAndDealName, updateContact, updateDeal, logEmailToTimeline, getLoggedCallCount } from './hubspot.js';
import { sendAsOwner, hasMailFrom } from './gmail.js';
import { sendSms, hasInboundSince } from './sms.js';
import { personalize, renderHtml, toPlainText, daysFromNow, appBaseUrl } from './util.js';
import { bookingLinkFor, smsNumberFor, getPlaceholders } from './settings.js';
import { registryVars } from './tokens.js';
import { resolveRegion, canSendNow, nextOpenAt } from './region.js';
import { logEvent, rememberSend, rememberLastSend, getLastSend, bumpStat, bumpFailure, clearFailures, rememberEngagement } from './activity.js';
import { bump as bumpMetric, registerLinks, indexSend, markReplied } from './metrics.js';
import { processChecklist } from './checklist.js';
import { getDesign } from './designs.js';                    // ← ADD
import { assembleMarketingEmail } from './marketing.js';    // ← ADD

// Base URL now lives in lib/util.js so the three copies of this logic can't drift.
const appUrl = appBaseUrl;

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
  // A missing phone used to bail out here with an error and no advance, so the contact was
  // retried every 5 minutes forever. It is now handled in the SMS block below, where
  // advance() exists and the step can be skipped instead.


  // ── Primary deal (newest owned): gives the sender's owner id AND the deal name, which
  //    often carries the lead's ZIP. Fetched once and reused for region resolution below. ──
  const primaryDeal = await getOwnerAndDealName(contact.id);

  // ── Sender: campaign-level override wins; otherwise the deal owner. ──
  let owner = null, ownerId = null;
  if (campaign.sendAs) {
    const match = Object.entries(ownerMap).find(([, o]) => o.email?.toLowerCase() === campaign.sendAs.toLowerCase());
    if (match) { ownerId = match[0]; owner = match[1]; }
    else owner = { email: campaign.sendAs, firstName: campaign.sendAsName || '', lastName: '' };
  } else {
    ownerId = primaryDeal.ownerId;
    owner = ownerId ? ownerMap[String(ownerId)] : null;
    if (!owner?.email) return { status: 'error', detail: `no deal owner resolvable (ownerId: ${ownerId})` };
  }

  const base = { contact: email || p.phone, campaign: p.dw_campaign, step: stepIndex + 1, sender: owner.email, channel };

  // ── Region: stamped value → contact ZIP → ZIP in the deal's location field → ZIP in the deal
  //    name. `resolved` is false when no real ZIP was found; we then withhold SMS (below) and
  //    never stamp a guessed region. ──
  const { region, stamped, resolved } = await resolveRegion({
    stampedRegion: primaryDeal.leadRegion, zip: p.zip_code, fallbackZips: [primaryDeal.location, primaryDeal.dealName]
  });
  if (!stamped && resolved && primaryDeal.dealId) {
    // lead_region is a DEAL property — stamping it on the contact returns HTTP 400.
    try {
      await updateDeal(primaryDeal.dealId, { lead_region: region });
    } catch (e) {
      await logEvent({ type: 'error', ...base, detail: `region stamp failed on deal ${primaryDeal.dealId}: ${e.message}` });
    }
  }

  // ── Send window + allowed days, in the lead's local time. Outside → DEFER (leave dw_next_send
  //    untouched; the 5-min cron retries until the window/day opens). No status is written. ──
  const gate = canSendNow(region, campaign.window, step.days);
  if (!gate.ok) {
    // Reschedule rather than leaving dw_next_send in the past. Otherwise this contact
    // stays at the head of the ASCENDING due queue and starves contacts that CAN send.
    //
    // Capped, deliberately. Parking a contact at the real next opening (possibly 15 hours
    // away) means a later change to the send window never reaches it, because it is no
    // longer in the due queue to be re-evaluated. Any future timestamp is enough to end
    // the starvation, so we take the nearer of "next opening" and "45 minutes from now".
    // Load still drops ~9x versus re-reading every 5 minutes, and a window edit takes
    // effect within the hour.
    const MAX_DEFER_MS = Number(process.env.MAX_DEFER_MS || 45 * 60 * 1000);
    const at = Math.min(nextOpenAt(region, campaign.window, step.days), Date.now() + MAX_DEFER_MS);
    try { await updateContact(contact.id, { dw_next_send: String(at) }); } catch { /* retry next run */ }
    return { status: 'skipped', detail: `deferred — ${gate.reason}; retrying ${new Date(at).toISOString().slice(11, 16)} UTC` };
  }

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
  // Scoped to THIS campaign: a reply to an earlier sequence must not unenrol a contact
  // from a new one, which is what happened when this marker was contact-wide.
  const lastSend = await getLastSend(contact.id, base.campaign);
  if (lastSend) {
    if (email) {
      const repliedEmail = await hasMailFrom(owner.email, email, lastSend);
      if (repliedEmail === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact emailed the owner' });
        await bumpStat(base.campaign, 'replied');
        await bumpStat(base.campaign, 'replied_email');   // split so the two channels are distinguishable in Reports
        await markReplied(contact.id, base.campaign);
        await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'replied' });
        return { status: 'replied', detail: `${email} replied to ${owner.email}; unenrolled` };
      }
    }
    if (campaignHasSms && smsNumberId && p.phone) {
      const repliedSms = await hasInboundSince({ phoneNumberId: smsNumberId, contactPhone: p.phone, sinceMs: lastSend });
      if (repliedSms === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact texted back' });
        await bumpStat(base.campaign, 'replied');
        await bumpStat(base.campaign, 'replied_sms');
        await markReplied(contact.id, base.campaign);
        await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'replied' });
        return { status: 'replied', detail: `${p.phone} texted back; unenrolled` };
      }
    }
    // null from either check (can't verify) → proceed with the send
  }

  // Global placeholder registry (Settings) → resolved against this contact + deal + owner.
  const placeholders = await getPlaceholders();
  const senderFullName = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
  const custom = registryVars(placeholders, {
    contact: p,
    deal: primaryDeal.properties || {},
    owner: { email: owner.email, firstname: owner.firstName, lastname: owner.lastName, fullname: senderFullName }
  });

  const vars = {
    ...custom,                       // built-ins below always win over the registry
    firstname: p.firstname,
    lastname: p.lastname,
    email: email,
    phone: p.phone,
    sender_firstname: owner.firstName,
    sender_lastname: owner.lastName,
    sender_fullname: senderFullName,
    sender_booking_link: await bookingLinkFor(owner.email)
  };

  const isLast = stepIndex + 1 >= campaign.steps.length;

  // ── Advance Logic (Modified for immediate recursion on 0 days) ──
  const advance = async () => {
    const nextStepNum = stepIndex + 2;
    // Safely parse string "0" or number 0
    const isZeroDelay = step.delayDaysAfter == null || Number(step.delayDaysAfter) === 0;

    if (isLast) {
      await updateContact(contact.id, {
        dw_next_send: '',
        dw_campaign_step: String(nextStepNum)
      });
      return false; // Done, do not recurse
    } else if (isZeroDelay) {
      const pastTime = String(Date.now() - 60000); // due now
      // Update HubSpot so it's correct in the CRM
      await updateContact(contact.id, {
        dw_next_send: pastTime,
        dw_campaign_step: String(nextStepNum)
      });
      
      // Update local memory so the recursive call sees the new state
      p.dw_campaign_step = String(nextStepNum);
      p.dw_next_send = pastTime;
      return true; // Return TRUE to trigger immediate recursion
    } else {
      const delayMs = Number(step.delayDaysAfter) * 24 * 60 * 60 * 1000;
      const nextTime = Date.now() + delayMs;
      await updateContact(contact.id, {
        dw_next_send: String(nextTime),
        dw_campaign_step: String(nextStepNum)
      });
      return false; // Future send, do not recurse
    }
  };

  // ── Giving up on a step ───────────────────────────────────────────────────
  // Permanent failures skip the step and move the sequence on. Transient ones are retried
  // a few times and then skipped anyway, so nothing can loop indefinitely.
  const MAX_ATTEMPTS = Number(process.env.MAX_STEP_ATTEMPTS || 3);

  const skipStep = async (detail, type = 'skipped') => {
    await logEvent({ type, ...base, detail });
    await clearFailures(contact.id, base.campaign, base.step);
    const rec = await advance();
    if (rec) return processContact(contact, campaigns, ownerMap);
    return { status: 'skipped', detail };
  };

  /** Retry a transient failure up to MAX_ATTEMPTS, then skip so it cannot loop. */
  const retryOrSkip = async (detail) => {
    const n = await bumpFailure(contact.id, base.campaign, base.step);
    if (n >= MAX_ATTEMPTS) {
      return skipStep(`${detail} — gave up after ${n} attempts, skipping this step`, 'error');
    }
    await logEvent({ type: 'error', ...base, detail: `${detail} (attempt ${n} of ${MAX_ATTEMPTS})` });
    return { status: 'error', detail };
  };

  /**
   * Three classes, because they deserve different treatment:
   *
   *   'contact'  400/404/422 — this contact's data is bad (dead number, malformed address).
   *              Skip the step. Retrying is pointless and it only affects this one person.
   *   'systemic' 401/402/403 — OUR credentials or billing. Skipping would silently drop the
   *              step for everyone in the queue, so hold and keep erroring instead: it is
   *              loud in the log, it fixes itself the moment the key is corrected, and no
   *              contact loses a step over it.
   *   'transient' 408/429/5xx/network — retry a few times, then skip so nothing loops.
   */
  const classify = (status) => {
    if ([401, 402, 403].includes(status)) return 'systemic';
    if ([400, 404, 422].includes(status)) return 'contact';
    return 'transient';
  };

  // ═══════════════ SMS ═══════════════
  if (channel === 'sms') {
    // Never text from a guessed number. Require a region resolved from a real ZIP (contact or
    // deal name); otherwise skip THIS step and move the sequence on — don't send.
    if (!resolved) {
      await logEvent({ type: 'skipped', ...base, detail: 'SMS withheld — no ZIP in contact or deal name; region unknown' });
      const rec = await advance();
      if (rec) return processContact(contact, campaigns, ownerMap);
      return { status: 'skipped', detail: 'SMS withheld — region unknown' };
    }
    if (!p.phone) {
      // No number to text. Nothing will change on a retry, so skip the step.
      return skipStep('SMS withheld — contact has no phone number (check `phone` vs `mobilephone`)');
    }
    if (!ownerId) {
      // Could be fixed by assigning a deal owner, so retry a few times before skipping.
      return retryOrSkip('SMS withheld — no deal owner id, so no number map lookup possible');
    }
    if (!smsNumberId) {
      // Owner has no number mapped for THIS region — don't fall back to another region's line; skip.
      await logEvent({ type: 'skipped', ...base, detail: `SMS withheld — no ${region} number configured for owner ${ownerId}` });
      const rec = await advance();
      if (rec) return processContact(contact, campaigns, ownerMap);
      return { status: 'skipped', detail: `SMS withheld — no ${region} number for owner ${ownerId}` };
    }
    const content = personalize(step.body, vars);
    const r = await sendSms({ from: smsNumberId, to: p.phone, content });
    if (!r.ok) {
      // A rejected number (400) is permanent: the same text will fail identically forever.
      const kind = classify(r.status);
      if (kind === 'contact') return skipStep(`${r.error} — number rejected, skipping this step`, 'error');
      if (kind === 'systemic') {
        // Config problem, not this contact. Hold the step so nobody is skipped over it.
        await logEvent({ type: 'error', ...base, detail: `${r.error} — OpenPhone credentials or billing need attention; holding this step` });
        return { status: 'error', detail: r.error };
      }
      return retryOrSkip(r.error);
    }
    await clearFailures(contact.id, base.campaign, base.step);
    // Texts get a sendId and an index entry too. There is no pixel or link tracking in an
    // SMS, but "hasn't replied in N hours" rules need the send to be findable by the sweep.
    const smsSendId = `${contact.id}.${stepIndex + 1}.${Date.now().toString(36)}`;
    await rememberSend(smsSendId, base);
    await indexSend(base.campaign, smsSendId);
    await rememberLastSend(contact.id, base.campaign);
    await logEvent({ type: 'sent', ...base, detail: `SMS via ${region} number` });
    await bumpStat(base.campaign, 'sent');
    await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'sent' });
    
    // Check if we need to fire the next step right now
    const shouldRecurse = await advance();
    if (shouldRecurse) {
      return processContact(contact, campaigns, ownerMap);
    }
    
    return { status: isLast ? 'completed' : 'sent', detail: `SMS step ${stepIndex + 1} → ${p.phone} (${region})` };
  }

  // ═══════════════ EMAIL ═══════════════
  const subject = personalize(step.subject, vars);
  const sendId = `${contact.id}.${stepIndex + 1}.${Date.now().toString(36)}`;

  let html;
  let text;   // plain-text part for Gmail + timeline

  if (step.format === 'design' && step.designId) {
    // Marketing design path — uses the pre-rendered HTML from the builder
    const record = await getDesign(step.designId);
    if (!record?.html) {
      await logEvent({ type: 'error', ...base, detail: `design "${step.designId}" missing or has no HTML` });
      return { status: 'error', detail: `design "${step.designId}" not found` };
    }
    const assembled = assembleMarketingEmail({
      record,
      vars,
      sendId,
      appUrl: appUrl(),
      footer: true,
      senderAddress: process.env.SENDER_ADDRESS || '',
      senderName: process.env.SENDER_NAME || 'Dogwise Academy'
    });
    html = assembled.html;
    text = assembled.text;
    // Store the link registry so /api/c can resolve an index to a URL server-side.
    if (assembled.links?.length) await registerLinks(sendId, assembled.links);
  } else {
    // Existing plain-text / markdown path — completely unchanged
    const rawBody = personalize(step.body || '', vars);
    text = toPlainText(rawBody);
    html = renderHtml(rawBody) +
      `<img src="${appUrl()}/api/px?e=${sendId}" width="1" height="1" alt="" style="display:none">`;
  }

  try {
    await sendAsOwner({
      senderEmail: owner.email,
      senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
      to: email,
      subject,
      body: text,
      html
    });
  } catch (e) {
    // Same reasoning as SMS: a 4xx from Gmail (bad address, bad delegation) will not fix
    // itself, and without advancing this contact would be retried every 5 minutes forever.
    const m = String(e.message || '').match(/\((\d{3})\)/);
    const kind = classify(m ? Number(m[1]) : 0);
    if (kind === 'contact') return skipStep(`${e.message} — skipping this step`, 'error');
    if (kind === 'systemic') {
      await logEvent({ type: 'error', ...base, detail: `${e.message} — Google delegation or scopes need attention; holding this step` });
      return { status: 'error', detail: e.message };
    }
    return retryOrSkip(e.message || 'Gmail send failed');
  }

  await clearFailures(contact.id, base.campaign, base.step);
  await rememberSend(sendId, base);
  await indexSend(base.campaign, sendId);   // lets the time-based rule sweep find this send
  await rememberLastSend(contact.id, base.campaign);
  await logEvent({ type: 'sent', ...base, subject });
  await bumpStat(base.campaign, 'sent');
  await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'sent' });

  try {
    const emailId = await logEmailToTimeline({
      contactId: contact.id,
      ownerId,
      subject,
      body: text,                     // uses the same text we just built
      html,                           // the actual rendered version, design or plain
      campaign: p.dw_campaign,
      step: stepIndex + 1
    });
    if (emailId) await rememberEngagement(sendId, emailId, text);
    else await logEvent({ type: 'error', ...base, detail: 'email sent but not logged to HubSpot timeline (no engagement id returned)' });
  } catch (e) {
    // Previously an unguarded catch swallowed this completely — the send worked, nothing
    // showed on the timeline, and there was no trace anywhere of why. Now it is visible.
    await logEvent({ type: 'error', ...base, detail: `email sent but timeline logging failed: ${e.message}` });
  }

  // Check if we need to fire the next step right now
  const shouldRecurse = await advance();
  if (shouldRecurse) {
    return processContact(contact, campaigns, ownerMap);
  }

  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };
}
