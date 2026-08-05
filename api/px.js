// api/px.js — 1×1 transparent gif for open tracking.
// Embedded in each HTML email as <img src="/api/px?e=<sendId>">. No PII in the URL —
// the sendId maps to send metadata stored in Redis at send time.
//
// Opens are now COUNTED, not just flagged once, so sequences can react to repeat opens.
// Read the caveat at the top of lib/metrics.js before trusting the number: Apple Mail
// prefetches images on delivery and Gmail caches them, so the count is directional heat,
// not proof of reading. Clicks are the reliable signal.
import { lookupSend, logEvent, bumpStat, getEngagement } from '../lib/activity.js';
import { formatPortalTime } from '../lib/util.js';
import { countOpen, bump, recordTimeToOpen, queueTrigger, getOpenCount, getClickCount } from '../lib/metrics.js';
import { updateEmailEngagement } from '../lib/hubspot.js';

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

      // MUST be awaited, not fire-and-forget. This used to be a bare .catch() with no
      // await in front, on the theory that not blocking the pixel response was worth it.
      // It was not: Vercel tears the function down once the response is sent, so an
      // in-flight PATCH with nothing still awaiting it gets cut off mid-request — which
      // surfaces as exactly the generic "fetch failed" error that filled the activity
      // feed, on almost every open, because that is close to the guaranteed outcome of
      // racing a network call against process teardown, not an occasional flake.
      const eng = await getEngagement(sendId);
      if (eng?.emailId) {
        const [opens, clicks] = await Promise.all([getOpenCount(sendId), getClickCount(sendId)]);
        const summary = `Opened ${opens.n}x, last opened ${formatPortalTime(opens.last || at)}`
          + (clicks.total ? ` · Clicked ${clicks.total}x` : '');
        try {
          await updateEmailEngagement(eng.emailId, { originalText: eng.originalText, originalHtml: eng.originalHtml, summary });
        } catch (e) {
          await logEvent({ type: 'error', contact: meta?.contact, campaign: meta?.campaign, step: meta?.step,
            detail: `timeline summary update failed: ${e.message}` });
        }
      } else if (meta?.channel === 'email') {
        // Diagnostic for exactly this bug: an open happened but there is no pointer to
        // patch, meaning the original log-to-timeline call either failed or was never
        // reached for this send.
        await logEvent({ type: 'error', contact: meta?.contact, campaign: meta?.campaign, step: meta?.step,
          detail: 'open recorded but no HubSpot engagement is linked to this send — check whether it was logged at send time' });
      }

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
