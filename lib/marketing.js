// lib/marketing.js — turns a stored marketing design into the final HTML + plain text
// for one recipient. No React, no new npm dependencies: the design was already rendered
// to HTML in the browser at save time, so all this does is string work.
//
// Responsibilities:
//   1. substitute {{tokens}} — HTML-escaped in the HTML part, raw in the text part
//   2. give the document a proper <head> (charset + viewport) — the builder's renderer
//      emits only <html><body>, which trips some Outlook/Android clients on accents
//   3. append the CAN-SPAM footer (physical address + one-click unsubscribe)
//   4. append the open-tracking pixel, inside <body> rather than after </html>

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function defaultFor(key) {
  return key.toLowerCase() === 'firstname' ? 'there' : '';
}

/** Same token grammar as lib/util.js personalize(), but escapes values for HTML context. */
export function personalizeHtml(html, vars) {
  return String(html).replace(TOKEN_RE, (_, key) => {
    const k = key.toLowerCase();
    const v = vars[k];
    return escAttr(v != null && v !== '' ? v : defaultFor(k));
  });
}

/** Raw substitution for the text/plain part. */
export function personalizeText(text, vars) {
  return String(text).replace(TOKEN_RE, (_, key) => {
    const k = key.toLowerCase();
    const v = vars[k];
    return v != null && v !== '' ? String(v) : defaultFor(k);
  });
}

/**
 * Walk an EmailBuilder.js document and pull out readable text, so the multipart/alternative
 * plain-text part isn't empty. Used as a fallback when the builder didn't supply `text`.
 *
 * Block shapes (verified against @usewaypoint/email-builder 0.0.9):
 *   EmailLayout      → data.childrenIds
 *   Container        → data.props.childrenIds
 *   ColumnsContainer → data.props.columns[n].childrenIds
 *   Text/Heading     → data.props.text
 *   Button           → data.props.text + data.props.url
 */
export function designToText(document, rootBlockId = 'root') {
  const out = [];
  const seen = new Set();

  const walk = id => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const block = document?.[id];
    if (!block) return;
    const d = block.data || {};
    const p = d.props || {};

    switch (block.type) {
      case 'EmailLayout':
        (d.childrenIds || []).forEach(walk);
        break;
      case 'Container':
        (p.childrenIds || []).forEach(walk);
        break;
      case 'ColumnsContainer':
        (p.columns || []).forEach(col => (col?.childrenIds || []).forEach(walk));
        break;
      case 'Heading':
      case 'Text': {
        const t = String(p.text || '').trim();
        if (t) out.push(t);
        break;
      }
      case 'Button': {
        const label = String(p.text || '').trim();
        const url = String(p.url || '').trim();
        if (label) out.push(url ? `${label}: ${url}` : label);
        break;
      }
      case 'Divider':
        out.push('----------');
        break;
      case 'Image': {
        const alt = String(p.alt || '').trim();
        if (alt) out.push(`[${alt}]`);
        break;
      }
      default:
        // Spacer, Avatar, Html and any future block type contribute nothing readable
        break;
    }
  };

  walk(rootBlockId);
  return out.join('\n\n');
}

/** Insert a <head> if the document has none. Idempotent. */
function ensureHead(html) {
  if (/<head[\s>]/i.test(html)) return html;
  const head =
    '<head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="x-apple-disable-message-reformatting">' +
    '</head>';
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1>${head}`);
  return head + html;
}

/** Append markup just before </body>, or at the end if there's no body tag. */
function appendToBody(html, extra) {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${extra}</body>`);
  return html + extra;
}

function footerHtml({ unsubscribeUrl, senderAddress, senderName }) {
  const bits = [];
  if (senderName) bits.push(escAttr(senderName));
  if (senderAddress) bits.push(escAttr(senderAddress));
  const who = bits.join(' · ');
  const unsub = unsubscribeUrl
    ? `<a href="${escAttr(unsubscribeUrl)}" style="color:#8892a0;text-decoration:underline">Unsubscribe</a>`
    : '';
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;' +
    'color:#8892a0;text-align:center;padding:22px 16px 28px;max-width:600px;margin:0 auto">' +
    (who ? `${who}<br>` : '') +
    (unsub ? `You received this because you enquired with us. ${unsub}` : '') +
    '</div>'
  );
}

function footerText({ unsubscribeUrl, senderAddress, senderName }) {
  const lines = ['', '----------'];
  if (senderName) lines.push(senderName);
  if (senderAddress) lines.push(senderAddress);
  if (unsubscribeUrl) lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  return lines.join('\n');
}

/**
 * Build the sendable pair for one recipient.
 *
 * @param {object}  o
 * @param {object}  o.record          the design record from lib/designs.js
 * @param {object}  o.vars            same vars object process.js already builds
 * @param {string}  o.sendId          existing tracking id (`${contactId}.${step}.${ts36}`)
 * @param {string}  o.appUrl          e.g. https://dogwise-mailer.vercel.app
 * @param {boolean} [o.footer=true]   set false for transactional-only sends
 * @param {string}  [o.senderAddress] physical postal address (CAN-SPAM)
 * @param {string}  [o.senderName]    business name for the footer
 * @returns {{ html: string, text: string }}
 */
export function assembleMarketingEmail({
  record, vars, sendId, appUrl,
  footer = true, senderAddress = '', senderName = ''
}) {
  if (!record?.html) throw new Error('Design record has no rendered HTML');

  const unsubscribeUrl = footer && sendId ? `${appUrl}/api/unsubscribe?e=${encodeURIComponent(sendId)}` : '';
  const pixel = sendId
    ? `<img src="${appUrl}/api/px?e=${encodeURIComponent(sendId)}" width="1" height="1" alt="" style="display:none">`
    : '';

  let html = personalizeHtml(record.html, vars);
  html = ensureHead(html);
  html = appendToBody(
    html,
    (footer ? footerHtml({ unsubscribeUrl, senderAddress, senderName }) : '') + pixel
  );

  const baseText = record.text?.trim()
    ? record.text
    : designToText(record.design, 'root');

  let text = personalizeText(baseText, vars);
  if (footer) text += footerText({ unsubscribeUrl, senderAddress, senderName });

  return { html, text };
}
