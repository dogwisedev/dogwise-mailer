// lib/util.js
// Token substitution now lives in lib/tokens.js — one grammar for emails, SMS and
// marketing designs. Re-exported here so existing call sites keep working.
export { personalize, personalizeHtml, personalizeText, TOKEN_RE } from './tokens.js';

/** True if current time is inside the allowed send window (default 8am–6pm, America/New_York). */
export function inSendWindow() {
  const tz = process.env.SEND_TZ || 'America/New_York';
  const startHour = parseInt(process.env.SEND_START_HOUR || '8', 10);
  const endHour = parseInt(process.env.SEND_END_HOUR || '18', 10);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()),
    10
  );
  return hour >= startHour && hour < endHour;
}

export function daysFromNow(days) {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

/**
 * Render the plain-text body the team writes into light HTML.
 * Supported syntax:
 *   [[button:Book a call|https://calendly.com/...]]   → styled button
 *   ![alt text](https://.../image.png)                → image
 *   [link text](https://...)                          → link
 *   blank line                                        → paragraph break
 * Everything else stays as-is; the plain-text version is sent alongside for fallback.
 */
export function renderHtml(body) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(body);

  // [[button:Text|url]] — empty URL degrades to plain text
  html = html.replace(/\[\[button:([^\|\]]*)\|([^\]]*)\]\]/g, (_, text, url) =>
    !url.trim() ? text.trim() :
    `<div style="margin:18px 0"><a href="${url.trim()}" target="_blank" ` +
    `style="background:#1B4F8A;color:#ffffff;padding:12px 26px;border-radius:6px;` +
    `text-decoration:none;font-weight:600;display:inline-block;font-family:Arial,sans-serif">${text.trim()}</a></div>`);

  // ![alt](url) images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) =>
    `<img src="${url.trim()}" alt="${alt.trim()}" style="max-width:100%;border-radius:6px;margin:10px 0" />`);

  // [text](url) links — empty URL degrades to plain text
  html = html.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, text, url) =>
    url.trim() ? `<a href="${url.trim()}" target="_blank" style="color:#1B4F8A">${text.trim()}</a>` : text.trim());

  // **bold** and *italic*
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // paragraphs, bullet lists (lines starting "- "), dividers (--- alone), line breaks
  html = html.split(/\n{2,}/).map(p => {
    if (p.trim() === '---') return '<hr style="border:none;border-top:1px solid #E3E9F0;margin:18px 0">';
    const lines = p.split('\n');
    if (lines.every(l => l.trim().startsWith('- ') || l.trim() === '')) {
      const items = lines.filter(l => l.trim().startsWith('- ')).map(l => `<li style="margin:0 0 6px">${l.trim().slice(2)}</li>`).join('');
      return `<ul style="margin:0 0 14px;padding-left:22px">${items}</ul>`;
    }
    return `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1E2A38;max-width:600px">${html}</div>`;
}

/** Strip formatting syntax for the plain-text fallback part. */
export function toPlainText(body) {
  return body
    .replace(/\[\[button:([^\|\]]*)\|([^\]]*)\]\]/g, (_, t, url) => url.trim() ? `${t}: ${url}` : t)
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, t, url) => url.trim() ? `${t} (${url})` : t)
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^---$/gm, '----------');
}

/**
 * The app's own base URL, used for tracked links, the open pixel and unsubscribe.
 *
 * Normalised deliberately. A bare `APP_URL=care.dogwiseacademy.com` (no scheme) yields
 * href="care.dogwiseacademy.com/api/c?..." which mail clients will not treat as an
 * absolute URL, so every link in every sent email dies silently. A trailing slash gives
 * a double slash. Both are easy to type and neither is obvious from the outside.
 */
export function appBaseUrl() {
  const raw = process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
    || 'https://dogwise-mailer.vercel.app';
  let u = String(raw).trim();
  // Markdown link syntax pasted straight into the env var: [https://x](https://x).
  // Copying a rendered link out of a chat window does this, and the result is a value
  // that starts with '[' so a plain scheme check waves it through.
  const md = u.match(/\]\(([^)]+)\)\s*$/) || u.match(/^\[([^\]]+)\]/);
  if (md) u = md[1].trim();
  u = u.replace(/^[<'"\s]+|[>'"\s]+$/g, '');            // stray quotes or angle brackets
  u = u.replace(/\/+$/, '');                             // trailing slashes
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;      // force a scheme
  return u;
}

/**
 * Format a timestamp in the HubSpot portal's own timezone, not the server's.
 *
 * Vercel's functions run in UTC. new Date(ms).toLocaleString('en-US') with no timeZone
 * option therefore renders in UTC, silently — HubSpot's OWN timestamp fields render
 * correctly because HubSpot itself converts to the account's timezone on display, but any
 * time we format into plain text ourselves inherits the server's zone instead, with no
 * indication that anything is off. That is what made a 3:31 PM open read as "3:31 PM" in
 * the timeline banner while HubSpot's own header on the same record correctly showed 5:30
 * PM GMT+2 for the same moment.
 *
 * Uses the real IANA zone rather than a fixed +1/+2 offset, so it does not drift wrong
 * across the March/October DST change.
 */
export function formatPortalTime(ms) {
  const tz = process.env.HUBSPOT_TZ || 'Europe/Madrid';
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: tz, month: 'numeric', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short'
    });
  } catch {
    return new Date(ms).toISOString();
  }
}
