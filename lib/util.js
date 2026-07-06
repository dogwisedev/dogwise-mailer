// lib/util.js
export function personalize(template, vars) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => {
    const v = vars[key.toLowerCase()];
    return v != null && v !== '' ? v : defaultFor(key);
  });
}

function defaultFor(key) {
  if (key.toLowerCase() === 'firstname') return 'there';
  return '';
}

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

  // [[button:Text|url]]
  html = html.replace(/\[\[button:([^\|\]]+)\|([^\]]+)\]\]/g, (_, text, url) =>
    `<div style="margin:18px 0"><a href="${url.trim()}" target="_blank" ` +
    `style="background:#1B4F8A;color:#ffffff;padding:12px 26px;border-radius:6px;` +
    `text-decoration:none;font-weight:600;display:inline-block;font-family:Arial,sans-serif">${text.trim()}</a></div>`);

  // ![alt](url) images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) =>
    `<img src="${url.trim()}" alt="${alt.trim()}" style="max-width:100%;border-radius:6px;margin:10px 0" />`);

  // [text](url) links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    `<a href="${url.trim()}" target="_blank" style="color:#1B4F8A">${text.trim()}</a>`);

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
    .replace(/\[\[button:([^\|\]]+)\|([^\]]+)\]\]/g, '$1: $2')
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^---$/gm, '----------');
}
