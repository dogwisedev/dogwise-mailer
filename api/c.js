// api/c.js — click tracking redirect.
//
// /api/c?e=<sendId>&i=<linkIndex>
//
// The destination is resolved SERVER-SIDE from dwm:links:<sendId>. The URL contains no
// attacker-controllable target, so this cannot be used as an open redirect.
import { getLinks, countClick, bump, queueTrigger } from '../lib/metrics.js';
import { lookupSend, logEvent, bumpStat } from '../lib/activity.js';

const FALLBACK = process.env.APP_URL || 'https://dogwiseacademy.com';

export default async function handler(req, res) {
  const sendId = String(req.query.e || '');
  const index = parseInt(String(req.query.i ?? ''), 10);

  let target = FALLBACK;

  try {
    const links = await getLinks(sendId);
    const entry = Number.isInteger(index) ? links[index] : null;
    if (entry?.url) target = entry.url;

    if (entry?.url) {
      const meta = await lookupSend(sendId);
      const c = await countClick({
        sendId, index, campaign: meta?.campaign, step: meta?.step, url: entry.url
      });

      if (c.first) {
        await bump({ campaign: meta?.campaign, step: meta?.step, metric: 'clicked' });
        // Also feed the all-time stats hash so the Activity tiles can show clicks
        // alongside sent/opened/replied.
        await bumpStat(meta?.campaign, 'clicked');
      }
      await bump({ campaign: meta?.campaign, step: meta?.step, metric: 'click_hit' });

      if (c.first) {
        await logEvent({
          type: 'clicked', ...(meta || {}),
          detail: `clicked "${entry.label}"`
        });
      }

      // Rule evaluation is deferred: a redirect must be fast.
      await queueTrigger({
        kind: 'click', sendId, index, url: entry.url, label: entry.label,
        campaign: meta?.campaign, step: meta?.step, contact: meta?.contact,
        clicksThisLink: c.n, clicksTotal: c.total
      });
    }
  } catch { /* a tracking failure must never break the customer's click */ }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Location', target);
  return res.status(302).end();
}
