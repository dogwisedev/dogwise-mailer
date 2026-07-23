// api/test-send.js — test EMAIL or SMS
// Email: ?as=owner@email.com&to=recipient@email.com&secret=...
// SMS:  ?as=owner@email.com&to=+15551234567&type=sms&secret=...

import { sendAsOwner } from '../lib/gmail.js';
import { sendSms } from '../lib/sms.js';
import { renderHtml, toPlainText, personalize } from '../lib/util.js';
import { bookingLinkFor, smsNumberFor } from '../lib/settings.js';
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap } from '../lib/hubspot.js';

export default async function handler(req, res) {
  const ok = (process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET) ||
             (process.env.ADMIN_PASSWORD && req.query.secret === process.env.ADMIN_PASSWORD);
  if (!ok) {
    return res.status(401).json({ error: 'unauthorized — pass ?secret=' });
  }

  const { as, to, type = 'email', secret } = 
    req.method === 'POST' ? (req.body || {}) : req.query;

  if (!as || !to) {
    return res.status(400).json({ error: 'as=... and to=... required' });
  }

  try {
    if (type === 'sms') {
      // ==================== SMS TEST ====================
      console.log('SMS Test requested:', { as, to });

      const campaigns = await getCampaigns();
      const ownerMap = await buildOwnerMap();

      // Find ownerId from email
      let ownerId = null;
      for (const [id, owner] of Object.entries(ownerMap)) {
        if (owner.email?.toLowerCase() === as.toLowerCase()) {
          ownerId = id;
          break;
        }
      }

      const region = 'East Coast'; // Change or make dynamic later
      const smsNumberId = await smsNumberFor(ownerId, region);

      if (!smsNumberId) {
        return res.status(400).json({ 
          ok: false, 
          error: `No OpenPhone number found for ${as} in ${region}. Check dashboard settings.` 
        });
      }

      const content = personalize("Test SMS from {{sender_firstname}} — this is a test from the mailer.", {
        sender_firstname: as.split('@')[0]
      });

      const r = await sendSms({ from: smsNumberId, to, content });

      return res.json({ 
        ok: r.ok, 
        type: 'sms',
        numberId: smsNumberId,
        detail: r.ok ? 'SMS sent successfully!' : r.error 
      });
    } 

    // ==================== Original EMAIL TEST (unchanged) ====================
    const custom = req.method === 'POST' ? (req.body || {}) : {};
    if (custom.body && custom.body.includes('{{sender_booking_link}}')) {
      const link = (await bookingLinkFor(as)) || 'https://dogwiseacademy.com';
      custom.body = custom.body.split('{{sender_booking_link}}').join(link);
      if (custom.subject) custom.subject = custom.subject.split('{{sender_booking_link}}').join(link);
    }

    const id = await sendAsOwner({
      senderEmail: as,
      senderName: custom.senderName || 'Dogwise Test',
      to,
      subject: custom.subject || 'Dogwise mailer — delegation test ✅',
      body: custom.body ? toPlainText(custom.body) : `This test email was sent as ${as} via the dogwise-mailer service account.\n\nIf you're reading this, domain-wide delegation is working.`,
      html: custom.body ? renderHtml(custom.body) : undefined
    });

    return res.status(200).json({ ok: true, gmailMessageId: id, sentAs: as, to, type: 'email' });
  } catch (err) {
    console.error('Test send error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
