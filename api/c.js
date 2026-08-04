// api/c.js — click tracking redirect.
//
// /api/c?e=<sendId>&i=<linkIndex>
//
// The destination is resolved SERVER-SIDE from dwm:links:<sendId>. The URL contains no
// attacker-controllable target, so this cannot be used as an open redirect.
import { getLinks, countClick, bump, queueTrigger, getOpenCount, getClickCount } from '../lib/metrics.js';
import { updateEmailEngagement } from '../lib/hubspot.js';
import { lookupSend, logEvent, bumpStat } from '../lib/activity.js';

import { appBaseUrl } from '../lib/util.js';

const FALLBACK = appBaseUrl();

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
        sendId, index, campaign: meta?.campaign, step: meta?.step, url: entry.url, label: entry.label
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

      // Same in-place rewrite as api/px.js on an open — one engagement, current numbers.
      const eng = await getEngagement(sendId);
      if (eng?.emailId) {
        const [opens, clicks] = await Promise.all([getOpenCount(sendId), getClickCount(sendId)]);
        const summary = `Opened ${opens.n}x` + (opens.last ? `, last ${new Date(opens.last).toLocaleString('en-US')}` : '')
          + ` · Clicked ${clicks.total}x (last: "${entry.label}")`;
        updateEmailEngagement(eng.emailId, { originalText: eng.originalText, summary }).catch(() => {});
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
