// api/bounce-sweep.js — hourly: read bounce notices from each owner's mailbox and
// suppress hard failures. Idempotent; safe to run more often than needed.
//
// Manual use before you trust it on a cron:
//   curl "https://<app>/api/bounce-sweep?secret=<ADMIN_PASSWORD>"          run a sweep
//   curl "https://<app>/api/bounce-sweep?secret=<ADMIN_PASSWORD>&list=1"   see the list
//
// Requires the `findBounceNotices` export added to lib/gmail.js — see
// patches/03-lib-gmail.js.md. Without it this endpoint returns an error and changes nothing.
import { buildOwnerMap } from '../lib/hubspot.js';
import { findBounceNotices } from '../lib/gmail.js';
import { sweepBounces, listSuppressed } from '../lib/bounces.js';

export default async function handler(req, res) {
  const ok =
    (process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET) ||
    (process.env.ADMIN_PASSWORD && req.query.secret === process.env.ADMIN_PASSWORD) ||
    (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  if (!ok) return res.status(401).json({ error: 'unauthorized — pass ?secret=' });

  if (req.query.list === '1') {
    return res.status(200).json({ suppressed: await listSuppressed() });
  }

  try {
    // Look back 2 hours on an hourly cron so a missed run doesn't lose bounces.
    const sinceMs = Date.now() - 2 * 60 * 60 * 1000;
    const ownerMap = await buildOwnerMap();
    const ownerEmails = [...new Set(Object.values(ownerMap).map(o => o.email).filter(Boolean))];

    const result = await sweepBounces({ findBounceNotices, ownerEmails, sinceMs });
    return res.status(200).json({ ok: true, mailboxes: ownerEmails.length, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
