// lib/links.js — rewrite outbound links for click tracking.
//
// SECURITY: the tracking URL carries an INDEX, never the destination.
//   /api/c?e=<sendId>&i=2
// The real target is stored server-side in dwm:links:<sendId> at send time. Putting the
// destination in the query string (?u=https://...) would make this an open redirect on
// your own domain, which gets found and abused for phishing and would wreck the sender
// reputation the rest of this system works to protect.
//
// DELIVERABILITY: rewriting links creates an anchor/href mismatch, which spamcheck.js
// flags, and makes an email look less like personal mail. So this is applied to marketing
// designs only, not to plain sequence steps. Unsubscribe and the tracking pixel are never
// rewritten.

const SKIP_PROTOCOLS = /^(mailto:|tel:|sms:|#|\{\{)/i;

function hostOf(u) { try { return new URL(u).hostname; } catch { return 'link'; } }

/** Links we must never rewrite: unsubscribe, the pixel, and unresolved tokens. */
function shouldSkip(url, appUrl) {
  if (!url) return true;
  const u = url.trim();
  if (SKIP_PROTOCOLS.test(u)) return true;
  if (/\/api\/(unsubscribe|px|c)\b/i.test(u)) return true;
  if (u.includes('{{')) return true;              // token not yet substituted
  if (!/^https?:\/\//i.test(u)) return true;      // relative or malformed
  return false;
}

/**
 * Rewrite every eligible href to a tracked redirect.
 * Call this AFTER token substitution, so {{stripe_link}} has become a real URL.
 *
 * @returns {{ html: string, links: Array<{url:string,label:string}> }}
 */
export function rewriteLinks({ html, sendId, appUrl }) {
  const links = [];
  if (!html || !sendId) return { html: html || '', links };

  const out = String(html).replace(
    /(<a\b[^>]*?\bhref=)(["'])(.*?)\2([^>]*>)([\s\S]*?)<\/a>/gi,
    (match, pre, q, url, post, inner) => {
      if (shouldSkip(url, appUrl)) return match;

      // Anchor text, stripped of tags, gives the click report a human label.
      const label = inner
        .replace(/<[^>]*>/g, ' ')
        .replace(/&rarr;|&#8594;/gi, '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ').trim().slice(0, 80)
        || hostOf(url);

      const index = links.length;
      links.push({ url, label });

      const tracked = `${appUrl}/api/c?e=${encodeURIComponent(sendId)}&i=${index}`;
      return `${pre}${q}${tracked}${q}${post}${inner}</a>`;
    }
  );

  return { html: out, links };
}

/** Same list without rewriting, for previews and diagnostics. */
export function extractLinks(html) {
  const links = [];
  const re = /<a\b[^>]*?\bhref=(["'])(.*?)\1/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (!shouldSkip(m[2])) links.push(m[2]);
  }
  return [...new Set(links)];
}
