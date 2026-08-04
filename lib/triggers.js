// lib/triggers.js — engagement rules that create HubSpot tasks.
//
// TWO EVALUATION MODES, because a negative condition has nothing to react to:
//
//   EVENT   rules with no delay. The pixel and click endpoints push a job onto dwm:tq and
//           runTriggers() drains it. Immediate, right for "clicked the payment link twice".
//
//   SWEEP   rules with a delay. runSweep() walks the send index for sends that are now old
//           enough to judge. Required for "hasn't opened in 24h", because nothing ever
//           fires an event for something that did not happen.
//
// RULE SHAPE
//   {
//     id: 'r1',
//     conditions: [ { metric: 'opens',  op: 'gte', value: 3 },
//                   { metric: 'clicks', op: 'eq',  value: 0 } ],   // ANDed
//     afterHours: 24,          // required if a condition can be true at zero
//     step: null,              // null = any step
//     linkContains: '',        // narrows click conditions
//     action: 'hubspot_task',
//     title: 'Call {{contact}}', note: '', dueInDays: 1, priority: 'MEDIUM', once: true
//   }
//
// The old { when: 'clicks'|'opens'|'opens_no_click', gte: n } shape is migrated on read, so
// rules saved before this change keep working without being touched.

import {
  drainTriggers, getClickCount, getOpenCount, sendsAged, sendStats, hasReplied
} from './metrics.js';
import { getOwnerAndDealName, createDealTask } from './hubspot.js';
import { logEvent, lookupSend } from './activity.js';
import { getCampaigns } from './store.js';

export const METRICS = ['opens', 'clicks', 'replies'];
export const OPS = ['gte', 'lte', 'eq'];

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

/** First time this rule fires for this send. Stops duplicate tasks. */
async function claimOnce(sendId, ruleId) {
  const r = await redis(['SET', `dwm:trig:${sendId}:${ruleId}`, '1', 'NX', 'EX', String(200 * 86400)]);
  return r === 'OK';
}

/** sendId is `${contactId}.${step}.${ts36}`. */
export function contactIdFromSendId(sendId) {
  const first = String(sendId || '').split('.')[0];
  return /^\d+$/.test(first) ? first : null;
}

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi,
    (_, k) => String(vars[k.toLowerCase()] ?? ''));
}

// ── Migration + normalisation ───────────────────────────────────────────────

/** A condition satisfiable at zero would fire the instant we send, so it needs a delay. */
function needsDelay(conditions) {
  return conditions.some(c => (c.op === 'eq' && c.value === 0) || c.op === 'lte');
}

export function normalizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {
    id: r.id || `r${Math.random().toString(36).slice(2, 8)}`,
    step: r.step == null || r.step === '' ? null : Number(r.step),
    linkContains: String(r.linkContains || ''),
    action: 'hubspot_task',
    title: String(r.title || ''),
    note: String(r.note || ''),
    dueInDays: r.dueInDays == null ? 1 : Number(r.dueInDays),
    priority: ['LOW', 'MEDIUM', 'HIGH'].includes(r.priority) ? r.priority : 'MEDIUM',
    once: r.once !== false,
    afterHours: Number.isFinite(Number(r.afterHours)) && Number(r.afterHours) > 0 ? Number(r.afterHours) : null,
    conditions: []
  };

  if (Array.isArray(r.conditions) && r.conditions.length) {
    out.conditions = r.conditions
      .filter(c => METRICS.includes(c?.metric) && OPS.includes(c?.op))
      .map(c => ({ metric: c.metric, op: c.op, value: Math.max(0, Math.trunc(Number(c.value) || 0)) }));
    // Any condition satisfiable at zero (opens/clicks == 0, or a `lte`) is true the
    // INSTANT a send lands with no engagement yet. Without a delay that fires a task
    // within the sweep's 1-hour floor rather than giving the recipient real time to
    // open or click. This was previously only defaulted on the legacy `when` shape below,
    // so a rule already saved in the new conditions[] shape with no afterHours (or 0,
    // which fails the truthiness check) slipped through and fired almost immediately.
    if (needsDelay(out.conditions) && !out.afterHours) out.afterHours = 24;
  } else {
    const gte = Math.max(1, Number(r.gte) || 1);
    if (r.when === 'clicks') out.conditions = [{ metric: 'clicks', op: 'gte', value: gte }];
    else if (r.when === 'opens') out.conditions = [{ metric: 'opens', op: 'gte', value: gte }];
    else if (r.when === 'opens_no_click') {
      out.conditions = [{ metric: 'opens', op: 'gte', value: gte }, { metric: 'clicks', op: 'eq', value: 0 }];
      // Legacy rules predate the delay field. They became sweep rules by migration, and
      // validation now requires a delay for anything satisfiable at zero — so give them a
      // sensible one rather than failing a rule the user saved before this existed.
      if (!out.afterHours) out.afterHours = 24;
    }
  }
  return out.conditions.length ? out : null;
}

export function normalizeRules(list) {
  return (Array.isArray(list) ? list : []).map(normalizeRule).filter(Boolean);
}

export function isSweepRule(rule) {
  return Boolean(rule.afterHours) || needsDelay(rule.conditions);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export function testCondition(c, stats) {
  const actual = Number(stats[c.metric] ?? 0);
  if (c.op === 'gte') return actual >= c.value;
  if (c.op === 'lte') return actual <= c.value;
  if (c.op === 'eq') return actual === c.value;
  return false;
}

/** Every condition must hold. */
export function evaluateConditions(conditions, stats) {
  return conditions.length > 0 && conditions.every(c => testCondition(c, stats));
}

/** Plain English, shown in the editor and written into the task note. */
export function describeRule(rule) {
  const word = { opens: 'opened it', clicks: 'clicked a link', replies: 'replied' };
  const parts = rule.conditions.map(c => {
    const w = word[c.metric] || c.metric;
    if (c.op === 'eq' && c.value === 0) return `has never ${c.metric === 'opens' ? 'opened it' : c.metric === 'clicks' ? 'clicked a link' : 'replied'}`;
    if (c.op === 'eq') return `${w} exactly ${c.value} time${c.value === 1 ? '' : 's'}`;
    if (c.op === 'lte') return `${w} ${c.value} time${c.value === 1 ? '' : 's'} or fewer`;
    return `${w} at least ${c.value} time${c.value === 1 ? '' : 's'}`;
  });
  let s = `When someone ${parts.join(' and ')}`;
  if (rule.step) s += ` on step ${rule.step}`;
  if (rule.linkContains) s += ` (only links containing "${rule.linkContains}")`;
  if (rule.afterHours) s += `, checked ${rule.afterHours}h after the send`;
  s += ', create a task for the deal owner';
  s += rule.dueInDays > 0 ? ` due in ${rule.dueInDays} day${rule.dueInDays === 1 ? '' : 's'}.` : ' due today.';
  return s;
}

// ── Firing ──────────────────────────────────────────────────────────────────

async function fireRule({ rule, campaign, campaignKey, sendId, step, contact, stats, linkLabel }) {
  if (rule.once && !(await claimOnce(sendId, rule.id))) return false;

  const contactId = contactIdFromSendId(sendId);
  if (!contactId) throw new Error(`no contact id in sendId ${sendId}`);

  const deal = await getOwnerAndDealName(contactId);
  if (!deal.dealId) throw new Error(`no deal for contact ${contactId}`);

  const vars = {
    contact: contact || '', campaign: campaignKey || '', step: step ?? '',
    link: linkLabel || '', opens: String(stats.opens), clicks: String(stats.clicks),
    dealname: deal.dealName || ''
  };

  const title = fill(rule.title, vars) || `Follow up with ${contact || 'lead'}`;
  const body = [
    fill(rule.note, vars),
    describeRule(rule),
    `Recorded: ${stats.opens} open(s), ${stats.clicks} click(s)${stats.replies ? ', replied' : ''} on step ${step}.`,
    linkLabel ? `Last link clicked: ${linkLabel}` : '',
    `Sequence: ${campaign.label || campaignKey}`
  ].filter(Boolean).join('\n');

  await createDealTask({
    dealId: deal.dealId,
    ownerId: deal.ownerId,
    subject: title,
    body,
    dueInDays: Number(rule.dueInDays ?? 1),
    priority: rule.priority
  });

  await logEvent({
    type: 'task', contact, campaign: campaignKey, step, channel: 'email',
    detail: `task created for deal ${deal.dealId}: ${title}`
  });
  return true;
}

// ── Mode 1: event-driven ────────────────────────────────────────────────────

export async function runTriggers(limit = 50) {
  const jobs = await drainTriggers(limit);
  const summary = { processed: jobs.length, fired: 0, errors: [] };
  if (!jobs.length) return summary;

  let campaigns;
  try { campaigns = await getCampaigns(); }
  catch (e) { summary.errors.push(`campaign load failed: ${e.message}`); return summary; }

  for (const job of jobs) {
    const campaign = campaigns[job.campaign];
    const rules = normalizeRules(campaign?.triggers).filter(r => !isSweepRule(r));
    if (!rules.length) continue;

    let stats;
    try {
      const [o, c] = await Promise.all([getOpenCount(job.sendId), getClickCount(job.sendId)]);
      const contactId = contactIdFromSendId(job.sendId);
      stats = {
        opens: o.n || 0,
        clicks: c.total || 0,
        replies: contactId && (await hasReplied(contactId, job.campaign)) ? 1 : 0
      };
    } catch (e) { summary.errors.push(`stats ${job.sendId}: ${e.message}`); continue; }

    for (const rule of rules) {
      try {
        if (rule.step != null && Number(rule.step) !== Number(job.step)) continue;
        if (rule.linkContains) {
          if (job.kind !== 'click') continue;
          const hay = `${job.url || ''} ${job.label || ''}`.toLowerCase();
          if (!hay.includes(rule.linkContains.toLowerCase())) continue;
        }
        if (!evaluateConditions(rule.conditions, stats)) continue;

        if (await fireRule({
          rule, campaign, campaignKey: job.campaign, sendId: job.sendId,
          step: job.step, contact: job.contact, stats, linkLabel: job.label
        })) summary.fired++;
      } catch (e) {
        summary.errors.push(`${job.campaign}/${rule.id}: ${e.message}`);
      }
    }
  }
  return summary;
}

// ── Mode 2: time-based sweep ────────────────────────────────────────────────

/**
 * Evaluate delayed rules. Scans each campaign's send index for sends whose age has passed
 * the rule's delay, bounded above by lookbackHours so we don't rescan all history every
 * five minutes. Dedupe handles anything seen twice inside that window.
 */
export async function runSweep({ maxPerRule = 25, lookbackHours = 48 } = {}) {
  const summary = { checked: 0, fired: 0, errors: [] };

  let campaigns;
  try { campaigns = await getCampaigns(); }
  catch (e) { summary.errors.push(`campaign load failed: ${e.message}`); return summary; }

  for (const [key, campaign] of Object.entries(campaigns)) {
    const rules = normalizeRules(campaign?.triggers).filter(isSweepRule);
    if (!rules.length) continue;

    for (const rule of rules) {
      const minAge = (rule.afterHours || 1) * 3600000;
      const maxAge = minAge + lookbackHours * 3600000;
      let sendIds = [];
      try { sendIds = await sendsAged(key, minAge, maxAge, maxPerRule); }
      catch (e) { summary.errors.push(`${key} index: ${e.message}`); continue; }

      for (const sendId of sendIds) {
        summary.checked++;
        try {
          const meta = await lookupSend(sendId);
          if (!meta) continue;
          if (rule.step != null && Number(rule.step) !== Number(meta.step)) continue;

          const contactId = contactIdFromSendId(sendId);
          const stats = await sendStats(sendId, contactId, key);
          if (!evaluateConditions(rule.conditions, stats)) continue;

          if (await fireRule({
            rule, campaign, campaignKey: key, sendId,
            step: meta.step, contact: meta.contact, stats
          })) summary.fired++;
        } catch (e) {
          summary.errors.push(`${key}/${rule.id}/${sendId}: ${e.message}`);
        }
      }
    }
  }
  return summary;
}

// ── Validation, for the campaigns API ───────────────────────────────────────

export function validateTriggers(list) {
  if (list === undefined) return '';
  if (!Array.isArray(list)) return 'Triggers must be a list';

  const seen = new Set();
  for (const [i, raw] of list.entries()) {
    const label = `Rule ${i + 1}`;
    const r = normalizeRule(raw);
    if (!r) return `${label}: needs at least one condition`;

    for (const c of r.conditions) {
      if (!METRICS.includes(c.metric)) return `${label}: unknown metric "${c.metric}"`;
      if (!OPS.includes(c.op)) return `${label}: unknown comparison "${c.op}"`;
      if (!Number.isInteger(c.value) || c.value < 0 || c.value > 1000) {
        return `${label}: the number must be between 0 and 1000`;
      }
    }
    if (needsDelay(r.conditions) && !r.afterHours) {
      return `${label}: a rule about something NOT happening needs an "after N hours" delay, or it fires the moment the email is sent`;
    }
    if (r.afterHours != null && (r.afterHours < 1 || r.afterHours > 720)) {
      return `${label}: the delay must be between 1 and 720 hours`;
    }
    if (r.step != null && (!Number.isInteger(r.step) || r.step < 1)) {
      return `${label}: step must be a step number, or blank for any step`;
    }
    if (!r.title.trim()) return `${label}: needs a task title`;
    if (r.dueInDays < 0 || r.dueInDays > 90) return `${label}: due in days must be 0 to 90`;
    if (seen.has(r.id)) return `${label}: duplicate rule id`;
    seen.add(r.id);
  }
  return '';
}
