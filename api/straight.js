// api/straight.js — every-minute cron for Straight campaigns only.
//
// HubSpot's "Send a webhook" workflow action needs Operations Hub Pro, which we don't
// have, so api/hook.js can't be triggered from a workflow. This does the same job by
// polling: once a minute it looks ONLY at Straight campaigns and sends whatever is due.
// A quote waits at most a minute. Idle cost is one HubSpot search per minute.
//
// The 5-minute api/cron.js still serves Straight first too; the per-contact lock in
// lib/process.js stops the two from sending the same email twice.
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap, getDueContactsIn, getContactsLive, getContactLive } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';
import { tierOf } from '../lib/allocate.js';

const MAX = parseInt(process.env.STRAIGHT_MAX_PER_RUN || '25', 10);
const TIME_BUDGET_MS = 50000;   // finish well inside a minute so runs don't pile up

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startedAt = Date.now();
  const summary = { sent: 0, skipped: 0, errors: [] };
  try {
    const campaigns = await getCampaigns();
    const keys = Object.entries(campaigns)
      .filter(([, c]) => c?.status !== 'paused' && tierOf(c) === 'straight')
      .map(([k]) => k);
    if (!keys.length) return res.status(200).json({ ...summary, note: 'no Straight campaigns' });

    const due = await getDueContactsIn(keys, MAX);
    if (!due.length) return res.status(200).json({ ...summary, due: 0 });

    const readAt = Date.now();
    const [ownerMap, fresh] = await Promise.all([
      buildOwnerMap(),
      getContactsLive(due.map((c) => c.id)).catch(() => new Map())
    ]);

    for (const c of due) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.note = 'time budget reached'; break; }
      try {
        const contact = fresh.get(String(c.id)) || await getContactLive(c.id);
        const r = await processContact(contact, campaigns, ownerMap, null, { readAt });
        if (r.status === 'sent' || r.status === 'completed') summary.sent++;
        else if (r.status === 'error') summary.errors.push({ id: c.id, error: r.detail });
        else summary.skipped++;
      } catch (e) {
        summary.errors.push({ id: c.id, error: e.message });
      }
    }
    summary.ms = Date.now() - startedAt;
    return res.status(200).json(summary);
  } catch (e) {
    return res.status(500).json({ ...summary, fatal: e.message });
  }
}
