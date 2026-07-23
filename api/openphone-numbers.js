// api/openphone-numbers.js — OpenPhone numbers for the "number" dropdown on the SMS
// numbers screen. Hitting this directly is also the quickest way to confirm the
// OpenPhone list-numbers API shape (see lib/sms.js listNumbers()).
import { listNumbers, smsConfigured } from '../lib/sms.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const configured = smsConfigured();
  const numbers = configured ? await listNumbers() : [];
  return res.status(200).json({ configured, numbers });
}
