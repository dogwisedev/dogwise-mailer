// api/alert-test.js — sends one test "Mailer alert" to every alert target that's set (Slack and/or Buzz),
// through the same code a real alert uses, and shows what each one answered.
// Open in the browser: /api/alert-test?secret=<ADMIN_PASSWORD>
import { sendAlert } from '../lib/alert.js';

export default async function handler(req, res) {
  const given = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.secret || '';
  if (!process.env.ADMIN_PASSWORD || given !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const r = await sendAlert('Mailer alert — TEST, nothing is wrong. Sent from /api/alert-test to check alerts reach this channel.');
  const line = (name, v) => `${name}: ${v === null ? 'not set (skipped)' : v === 'ok' ? 'sent ✓' : `FAILED: ${v}`}`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send([
    'Mailer alert test',
    '',
    line('Slack (ALERT_WEBHOOK_URL)', r.webhook),
    line('Buzz (BUZZ_ALERT_URL + BUZZ_ALERT_SECRET)', r.buzz),
    '',
    r.buzz === 'HTTP 404' ? 'Buzz answered "not found". It says that for all of these: the secret doesn\'t match, the URL is wrong, the workflow is off, or its creator left the channel.' :
    r.buzz === 'HTTP 400' ? 'Buzz answered "bad request": the URL isn\'t a workflow\'s /hooks/ address.' :
    r.buzz === 'ok' ? 'Buzz accepted it. If nothing shows in the channel, check the workflow\'s message text is exactly {{trigger.message}}.' : ''
  ].join('\n'));
}
