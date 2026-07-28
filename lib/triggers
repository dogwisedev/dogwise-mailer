// lib/triggers.js — evaluate engagement rules and act on them.
//
// The pixel (api/px.js) and the click redirect (api/c.js) must return fast, so they only
// push a job onto dwm:tq. This module drains that queue from the cron and decides whether
// a rule fired.
//
// RULE SHAPE, stored on the campaign as `triggers: []`:
//   {
//     id:        'r1',                       stable id, used for once-only dedupe
//     when:      'clicks' | 'opens' | 'opens_no_click',
//     gte:       2,                          threshold, inclusive
//     step:      null,                       null = any step, or a step number
//     linkContains: 'stripe',                optional substring filter (clicks only)
//     action:    'hubspot_task',
//     title:     'Call {{contact}} — clicked the payment link',
//     note:      '',
//     dueInDays: 1,
//     priority:  'HIGH',
//     once:      true                        one task per send, not per event
//   }
//
// WHY 'opens_no_click' EXISTS
// Open counts are unreliable on their own: Apple Mail prefetches images on delivery and
// Gmail caches them, so the number is skewed by mail client. But repeated opens with zero
// clicks is a genuinely useful sales signal — someone interested who has not found the
// button. That is the pattern worth putting in front of a rep.

import { drainTriggers, getClickCount, getOpenCount } from './metrics.js';
import { getOwnerAndDealName, createDealTask } from './hubspot.js';
import { logEvent } from './activity.js';
import { getCampaigns } from './store.js';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!URL_ || !TOKEN) return null;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    if (!res.ok) return null;
    return (await res.json()).result;
  } catch { return null; }
}

/** True the first time this rule fires for this send. Prevents duplicate tasks. */
async function claimOnce(sendId, ruleId) {
  const r = await redis(['SET', `dwm:trig:${sendId}:${ruleId}`, '1', 'NX', 'EX', String(120 * 86400)]);
  return r === 'OK';
}

/** sendId is `${contactId}.${step}.${ts36}` — the contact id is the first segment. */
export function contactIdFromSendId(sendId) {
  const first = String(sendId || '').split('.')[0];
  return /^\d+$/.test(first) ? first : null;
}

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi,
    (_, k) => String(vars[k.toLowerCase()] ?? ''));
}

/** Does one rule match one queued job? */
export async function ruleMatches(rule, job) {
  if (!rule || rule.action !== 'hubspot_task') return false;
  if (rule.step != null && Number(rule.step) !== Number(job.step)) return false;

  const gte = Math.max(1, Number(rule.gte) || 1);

  if (rule.when === 'clicks') {
    if (job.kind !== 'click') return false;
    if (rule.linkContains) {
      const hay = `${job.url || ''} ${job.label || ''}`.toLowerCase();
      if (!hay.includes(String(rule.linkContains).toLowerCase())) return false;
      return Number(job.clicksThisLink || 0) >= gte;
    }
    return Number(job.clicksTotal || 0) >= gte;
  }

  if (rule.when === 'opens') {
    if (job.kind !== 'open') return false;
    return Number(job.opens || 0) >= gte;
  }

  if (rule.when === 'opens_no_click') {
    if (job.kind !== 'open') return false;
    if (Number(job.opens || 0) < gte) return false;
    const clicks = await getClickCount(job.sendId);
    return (clicks.total || 0) === 0;
  }

  return false;
}

/**
 * Drain the queue and act. Safe to call every cron run.
 * @returns {{ processed:number, fired:number, errors:string[] }}
 */
export async function runTriggers(limit = 50) {
  const jobs = await drainTriggers(limit);
  const summary = { processed: jobs.length, fired: 0, errors: [] };
  if (!jobs.length) return summary;

  let campaigns;
  try { campaigns = await getCampaigns(); }
  catch (e) { summary.errors.push(`campaign load failed: ${e.message}`); return summary; }

  for (const job of jobs) {
    const campaign = campaigns[job.campaign];
    const rules = campaign?.triggers;
    if (!Array.isArray(rules) || !rules.length) continue;

    for (const rule of rules) {
      try {
        if (!(await ruleMatches(rule, job))) continue;

        const ruleId = rule.id || `${rule.when}:${rule.gte}`;
        if (rule.once !== false && !(await claimOnce(job.sendId, ruleId))) continue;

        const contactId = contactIdFromSendId(job.sendId);
        if (!contactId) { summary.errors.push(`no contact id in sendId ${job.sendId}`); continue; }

        const deal = await getOwnerAndDealName(contactId);
        if (!deal.dealId) { summary.errors.push(`no deal for contact ${contactId}`); continue; }

        const opens = job.kind === 'open' ? job.opens : (await getOpenCount(job.sendId)).n;
        const vars = {
          contact: job.contact || '', campaign: job.campaign || '', step: job.step ?? '',
          dog_name: '', link: job.label || job.url || '', url: job.url || '',
          opens: String(opens || 0), clicks: String(job.clicksTotal || 0),
          dealname: deal.dealName || ''
        };

        const title = fill(rule.title, vars) || `Follow up with ${job.contact || 'lead'}`;
        const noteBits = [
          fill(rule.note, vars),
          job.kind === 'click'
            ? `Clicked "${job.label || job.url}" (${job.clicksThisLink}x) in step ${job.step}.`
            : `Opened step ${job.step} ${opens} time(s)${rule.when === 'opens_no_click' ? ' without clicking anything' : ''}.`,
          `Sequence: ${campaign.label || job.campaign}`
        ].filter(Boolean);

        await createDealTask({
          dealId: deal.dealId,
          ownerId: deal.ownerId,
          subject: title,
          body: noteBits.join('\n'),
          dueInDays: Number(rule.dueInDays ?? 1),
          priority: ['LOW', 'MEDIUM', 'HIGH'].includes(rule.priority) ? rule.priority : 'MEDIUM'
        });

        summary.fired++;
        await logEvent({
          type: 'task', contact: job.contact, campaign: job.campaign, step: job.step,
          channel: 'email', detail: `task created for deal ${deal.dealId}: ${title}`
        });
      } catch (e) {
        summary.errors.push(`${job.campaign}/${rule.when}: ${e.message}`);
      }
    }
  }

  return summary;
}

/** Validate rules coming from the campaign editor. Returns an error string or ''. */
export function validateTriggers(list) {
  if (list === undefined) return '';
  if (!Array.isArray(list)) return 'Triggers must be a list';
  const WHEN = ['clicks', 'opens', 'opens_no_click'];
  const seen = new Set();
  for (const [i, r] of list.entries()) {
    const label = `Trigger ${i + 1}`;
    if (!WHEN.includes(r?.when)) return `${label}: "when" must be one of ${WHEN.join(', ')}`;
    if (r.action !== 'hubspot_task') return `${label}: only the HubSpot task action is supported`;
    const gte = Number(r.gte);
    if (!Number.isInteger(gte) || gte < 1 || gte > 100) return `${label}: threshold must be between 1 and 100`;
    if (r.step != null && (!Number.isInteger(Number(r.step)) || Number(r.step) < 1)) return `${label}: step must be a step number or blank for any`;
    if (!String(r.title || '').trim()) return `${label}: needs a task title`;
    if (r.dueInDays != null && (Number(r.dueInDays) < 0 || Number(r.dueInDays) > 90)) return `${label}: due in days must be 0 to 90`;
    const id = r.id || `${r.when}:${r.gte}`;
    if (seen.has(id)) return `${label}: duplicate rule`;
    seen.add(id);
  }
  return '';
}
