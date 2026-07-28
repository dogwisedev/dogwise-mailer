// api/px.js — 1×1 transparent gif for open tracking.
// Embedded in each HTML email as <img src="/api/px?e=<sendId>">. No PII in the URL —
// the sendId maps to send metadata stored in Redis at send time.
//
// Opens are now COUNTED, not just flagged once, so sequences can react to repeat opens.
// Read the caveat at the top of lib/metrics.js before trusting the number: Apple Mail
// prefetches images on delivery and Gmail caches them, so the count is directional heat,
// not proof of reading. Clicks are the reliable signal.
import { lookupSend, logEvent, bumpStat } from '../lib/activity.js';
import { countOpen, bump, recordTimeToOpen, queueTrigger } from '../lib/metrics.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default async function handler(req, res) {
  const sendId = String(req.query.e || '');

  if (sendId) {
    try {
      const at = Date.now();
      const { n, first } = await countOpen(sendId, at);
      const meta = await lookupSend(sendId);

      if (first) {
        await logEvent({ type: 'opened', ...(meta || { detail: `unknown send ${sendId}` }) });
        await bumpStat(meta?.campaign, 'opened');
        await bump({ campaign: meta?.campaign, step: meta?.step, metric: 'opened', at });
        if (meta?.sentAt) await recordTimeToOpen(meta.campaign, Number(meta.sentAt), at);
      }
      await bump({ campaign: meta?.campaign, step: meta?.step, metric: 'open_hit', at });

      await queueTrigger({
        kind: 'open', sendId, campaign: meta?.campaign, step: meta?.step,
        contact: meta?.contact, opens: n
      });
    } catch { /* never fail the pixel */ }
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Content-Length', GIF.length);
  return res.status(200).send(GIF);
}
