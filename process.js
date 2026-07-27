// lib/gmail.js — send email as any @dogwiseacademy.com user via domain-wide delegation
import { JWT } from 'google-auth-library';

const SCOPES_SEND = ['https://www.googleapis.com/auth/gmail.send'];
const SCOPES_READ = ['https://www.googleapis.com/auth/gmail.readonly'];

function getKey() {
  // Vercel env vars keep literal \n if pasted via CLI; dashboard pastes keep real newlines.
  return (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
}

async function getAccessToken(impersonateEmail, scopes = SCOPES_SEND) {
  const client = new JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: getKey(),
    scopes,
    subject: impersonateEmail
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error(`No access token for ${impersonateEmail}`);
  return token;
}

/**
 * Has `fromEmail` sent anything to `ownerEmail`'s mailbox since `sinceMs`?
 * Returns true/false — or null if the readonly scope isn't granted / check failed
 * (callers treat null as "can't check, proceed").
 */
export async function hasMailFrom(ownerEmail, fromEmail, sinceMs) {
  try {
    const token = await getAccessToken(ownerEmail, SCOPES_READ);
    const q = encodeURIComponent(`from:${fromEmail} after:${Math.floor(sinceMs / 1000)}`);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.resultSizeEstimate || 0) > 0 || (data.messages || []).length > 0;
  } catch {
    return null; // scope not granted yet, or transient failure — never block sends on this
  }
}

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047: email headers are ASCII-only — emoji/accents must be wrapped as =?UTF-8?B?...?=
function encodeHeader(str) {
  if (!/[^\x20-\x7E]/.test(str)) return str; // plain ASCII — leave as-is
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, fromName, to, subject, body, html, extraHeaders }) {
  const fromHeader = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    // CR/LF stripped: these values interpolate a URL, and a newline here would let a
    // crafted send id inject arbitrary headers. With no extraHeaders passed, this spread
    // contributes nothing and the output is byte-identical to before.
    ...Object.entries(extraHeaders || {}).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`)
  ];

  if (!html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64')
    ].join('\r\n');
  }

  // multipart/alternative: plain text fallback + HTML
  const boundary = 'dwm_' + Math.random().toString(36).slice(2);
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`
  ].join('\r\n');
}

/**
 * Send an email as `senderEmail` (the deal owner).
 * Pass `html` for a rich version alongside the plain-text `body`.
 * Returns the Gmail message id.
 */
export async function sendAsOwner({ senderEmail, senderName, to, subject, body, html, extraHeaders }) {
  const token = await getAccessToken(senderEmail);
  const raw = base64url(buildMime({ from: senderEmail, fromName: senderName, to, subject, body, html, extraHeaders }));

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

/**
 * Bounce notices in `ownerEmail`'s mailbox since `sinceMs`.
 * Returns [{ subject, snippet }]. Empty array on any failure — bounce sweeping must never
 * be able to break a send. Uses the gmail.readonly scope already granted for reply detection.
 */
export async function findBounceNotices(ownerEmail, sinceMs, max = 25) {
  try {
    const token = await getAccessToken(ownerEmail, SCOPES_READ);
    const q = encodeURIComponent(
      `(from:mailer-daemon OR from:postmaster) after:${Math.floor(sinceMs / 1000)}`
    );
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${max}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listRes.ok) return [];
    const { messages = [] } = await listRes.json();

    const out = [];
    for (const m of messages) {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) continue;
      const d = await r.json();
      const subject = (d.payload?.headers || []).find(h => h.name?.toLowerCase() === 'subject')?.value || '';
      out.push({ subject, snippet: d.snippet || '' });
    }
    return out;
  } catch {
    return [];
  }
}
