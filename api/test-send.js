// api/test-send.js — verify domain-wide delegation works.
// Usage (after deploy):
//   GET /api/test-send?as=you@dogwiseacademy.com&to=you@dogwiseacademy.com&secret=<CRON_SECRET>
import { sendAsOwner } from '../lib/gmail.js';
import { renderHtml, toPlainText } from '../lib/util.js';
import { bookingLinkFor } from '../lib/settings.js';

export default async function handler(req, res) {
  const ok = (process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET)
    || (process.env.ADMIN_PASSWORD && req.query.secret === process.env.ADMIN_PASSWORD);
  if (!ok) {
    return res.status(401).json({ error: 'unauthorized — pass ?secret=' });
  }

  const { as, to } = req.method === 'POST' ? (req.body || {}) : req.query;
  if (!as || !to) {
    return res.status(400).json({ error: 'pass as=<sender@dogwiseacademy.com> and to=<recipient>' });
  }

  const custom = req.method === 'POST' ? (req.body || {}) : {};
  if (custom.body && custom.body.includes('{{sender_booking_link}}')) {
    const link = (await bookingLinkFor(as)) || 'https://dogwiseacademy.com';
    custom.body = custom.body.split('{{sender_booking_link}}').join(link);
    if (custom.subject) custom.subject = custom.subject.split('{{sender_booking_link}}').join(link);
  }

  try {
    const id = await sendAsOwner({
      senderEmail: as,
      senderName: custom.senderName || 'Dogwise Test',
      to,
      subject: custom.subject || 'Dogwise mailer — delegation test ✅',
      body: custom.body ? toPlainText(custom.body) : `This test email was sent as ${as} via the dogwise-mailer service account.\n\nIf you're reading this, domain-wide delegation is working.`,
      html: custom.body ? renderHtml(custom.body) : undefined
    });
    return res.status(200).json({ ok: true, gmailMessageId: id, sentAs: as, to });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
