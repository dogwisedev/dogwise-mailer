// api/px.js — 1×1 transparent gif for open tracking.
// Embedded in each HTML email as <img src="/api/px?e=<sendId>">. No PII in the URL —
// the sendId maps to send metadata stored in Redis at send time.
import { lookupSend, markOpenedOnce, logEvent, bumpStat } from '../lib/activity.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default async function handler(req, res) {
  const sendId = String(req.query.e || '');

  // Log first open only, and never let tracking delay the image response meaningfully
  if (sendId) {
    try {
      const first = await markOpenedOnce(sendId);
      if (first) {
        const meta = await lookupSend(sendId);
        await logEvent({ type: 'opened', ...(meta || { detail: `unknown send ${sendId}` }) });
        await bumpStat(meta?.campaign, 'opened');
      }
    } catch { /* never fail the pixel */ }
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Content-Length', GIF.length);
  return res.status(200).send(GIF);
}
