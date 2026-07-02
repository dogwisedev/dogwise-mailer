// lib/gmail.js — send email as any @dogwiseacademy.com user via domain-wide delegation
import { JWT } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

function getKey() {
  // Vercel env vars keep literal \n if pasted via CLI; dashboard pastes keep real newlines.
  return (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
}

async function getAccessToken(impersonateEmail) {
  const client = new JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: getKey(),
    scopes: SCOPES,
    subject: impersonateEmail
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error(`No access token for ${impersonateEmail}`);
  return token;
}

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMime({ from, fromName, to, subject, body }) {
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  return [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].join('\r\n');
}

/**
 * Send a plain-text email as `senderEmail` (the deal owner).
 * Returns the Gmail message id.
 */
export async function sendAsOwner({ senderEmail, senderName, to, subject, body }) {
  const token = await getAccessToken(senderEmail);
  const raw = base64url(buildMime({ from: senderEmail, fromName: senderName, to, subject, body }));

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail send failed (${res.status}) as ${senderEmail}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.id;
}
