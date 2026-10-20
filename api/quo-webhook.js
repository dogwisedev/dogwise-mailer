// api/quo-webhook.js — Quo (OpenPhone) calls this the moment a lead texts any of our lines.
//
// Before this, a text reply was only noticed when the contact's NEXT step came due, and
// only if a text had already gone out in that campaign — so a reply after the last step,
// or to an email-only sequence, never stopped anything. Now a reply stops the sequence
// within seconds, exactly like an email reply does.
//
// Setup (Quo → Settings → Integrations → Webhooks → New webhook):
//   URL:     https://<app>.vercel.app/api/quo-webhook?secret=<CRON_SECRET>
//   Event:   message.received
//   Numbers: all the lines the mailer texts from
// Optional: paste the webhook's signing secret into QUO_WEBHOOK_SIGNING_KEY to also
// verify Quo's signature on every call.
import crypto from 'node:crypto';
import { getCampaigns } from '../lib/store.js';
import { findContactsByPhone, updateContact } from '../lib/hubspot.js';
import { toE164 } from '../lib/sms.js';
import { logEvent, bumpStat, getLastSend, claimOnce } from '../lib/activity.js';
import { markReplied, bump as bumpMetric } from '../lib/metrics.js';

const REPLY_WINDOW_MS = 14 * 86400000;   // same as api/sweep.js for completed sequences

async function rawBody(req) {
  // Vercel parses req.body lazily, so the stream is still readable as long as
  // nothing touched req.body first. Raw bytes are what the signature is over.
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  return req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : '';
}

/** Header format: hmac;1;<timestamp>;<base64 digest> over `${timestamp}.${body}`. */
function signatureOk(header, body, key) {
  try {
    const [scheme, , ts, sig] = String(header || '').split(';');
    if (scheme !== 'hmac' || !ts || !sig) return false;
    const digest = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(`${ts}.${body}`).digest('base64');
    const a = Buffer.from(digest), b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const expected = process.env.QUO_WEBHOOK_SECRET || process.env.CRON_SECRET;
  if (expected && req.query?.secret !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = await rawBody(req);
  const key = (process.env.QUO_WEBHOOK_SIGNING_KEY || '').trim();
  if (key && !signatureOk(req.headers['openphone-signature'] || req.headers['quo-signature'], body, key)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  let evt;
  try { evt = JSON.parse(body || '{}'); } catch { return res.status(200).json({ ok: false, reason: 'not json' }); }

  // Always 200 from here on: Quo retries anything else, and nothing below gets
  // better on a retry.
  const msg = evt?.data?.object || {};
  const type = String(evt?.type || '');
  const direction = String(msg.direction || '').toLowerCase();
  if (type && type !== 'message.received') return res.status(200).json({ ok: true, ignored: type });
  if (direction && direction !== 'incoming' && direction !== 'inbound') return res.status(200).json({ ok: true, ignored: 'outgoing' });

  const from = toE164(msg.from);
  if (!from) return res.status(200).json({ ok: true, ignored: 'no usable sender number' });
  const receivedAt = new Date(msg.createdAt || evt.createdAt || Date.now()).getTime();
  const once = msg.id ? await claimOnce(`dwm:quo:${msg.id}`) : true;   // Quo retries: count each text once

  const out = { ok: true, from, stopped: [], logged: [] };
  try {
    const [contacts, campaigns] = await Promise.all([findContactsByPhone(from), getCampaigns()]);

    for (const c of contacts) {
      const p = c.properties || {};
      const campaign = p.dw_campaign;
      if (!campaign || campaigns[campaign]?.type === 'checklist') continue;   // onboarding stops only when the checklist is done

      // Only a reply if we have actually sent something in this campaign before it.
      const lastSend = await getLastSend(c.id, campaign);
      if (!lastSend || receivedAt < lastSend) continue;

      const step = Math.max(1, parseInt(p.dw_campaign_step || '2', 10) - 1);
      const who = p.email || p.phone || c.id;

      if (p.dw_next_send) {
        // Still in the sequence: stop it.
        await updateContact(c.id, { dw_campaign: '', dw_next_send: '' });
        await markReplied(c.id, campaign);
        if (once) {
          await logEvent({ type: 'replied', contact: who, campaign, step, channel: 'sms', detail: 'sequence stopped — contact texted back' });
          await bumpStat(campaign, 'replied');
          await bumpStat(campaign, 'replied_sms');
          await bumpMetric({ campaign, step, metric: 'replied' });
        }
        out.stopped.push({ id: c.id, campaign });
      } else if (Date.now() - lastSend <= REPLY_WINDOW_MS && once) {
        // Sequence already finished: count the reply, nothing to stop.
        await markReplied(c.id, campaign);
        await logEvent({ type: 'replied', contact: who, campaign, step, channel: 'sms', detail: 'text reply after sequence completed' });
        await bumpStat(campaign, 'replied');
        await bumpStat(campaign, 'replied_sms');
        out.logged.push({ id: c.id, campaign });
      }
    }
  } catch (e) {
    // Logged, not retried: the next step's own reply check is still the backstop.
    await logEvent({ type: 'error', contact: from, channel: 'sms', detail: `Quo reply webhook: ${e.message}` }).catch(() => {});
    out.ok = false; out.error = e.message;
  }

  return res.status(200).json(out);
}
