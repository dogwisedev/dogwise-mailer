// lib/spamcheck.js — preflight deliverability linter. Zero dependencies.
//
// Runs on the rendered HTML + text part of a marketing design (and, separately, on a
// subject line) and returns concrete, actionable findings. Advisory only: it never blocks
// a save. The point is that nobody ships a 400 KB single-image email by accident.
//
// The checks are deliberately narrow. A 200-word "spam word list" produces noise that
// people learn to ignore; everything here is either a hard mechanical fact (Gmail's clip
// threshold, missing text part) or a signal that filters genuinely weight heavily
// (image-only bodies, URL shorteners, anchor/href mismatch, hidden text).

const HIGH = 'high', MED = 'medium', LOW = 'low';

const SHORTENERS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'lnk.to', 'tiny.cc',
  's.id', 'shrtco.de', 'v.gd', 'trib.al'
];

// Phrases that carry real weight in content filters AND are plausible in this business.
// Kept short on purpose.
const PHRASES = [
  'act now', 'limited time only', 'click here', 'risk free', 'risk-free',
  '100% free', 'no obligation', 'money back guarantee', 'money-back guarantee',
  'buy now', 'order now', 'last chance', 'don\'t miss out', 'dont miss out',
  'special promotion', 'no credit check', 'you have been selected',
  'congratulations you', 'call now', 'apply now', 'while supplies last',
  'satisfaction guaranteed', 'lowest price', 'save big'
];

const GMAIL_CLIP_BYTES = 102400; // ~102 KB — Gmail clips beyond this and hides your footer

function bytes(s) {
  // Buffer isn't available in a browser context; TextEncoder is available in both.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return Buffer.byteLength(s, 'utf8');
}

/** Strip tags/scripts/styles down to human-visible text. */
function visibleText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tagHtml) {
  const out = {};
  const re = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(tagHtml))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

function hostOf(url) {
  const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function registrable(host) {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/**
 * Lint a rendered marketing email body.
 *
 * @param {object}  o
 * @param {string}  o.html                  the rendered HTML (from the builder)
 * @param {string}  o.text                  the text/plain part
 * @param {boolean} [o.footerAdded=true]    true when lib/marketing.js will append the
 *                                          unsubscribe footer, so don't flag its absence
 * @param {string}  [o.ownDomain]           e.g. 'dogwiseacademy.com' — links/images here
 *                                          are treated as first-party
 * @returns {{ score: number, findings: Array<{level,code,message,fix}> }}
 */
export function checkBody({ html, text, footerAdded = true, ownDomain = '' }) {
  const f = [];
  const add = (level, code, message, fix) => f.push({ level, code, message, fix });

  const H = String(html || '');
  const T = String(text || '');
  const own = registrable(String(ownDomain).toLowerCase().replace(/^www\./, ''));

  // ── Size ──────────────────────────────────────────────────────────────────
  const size = bytes(H);
  if (size > GMAIL_CLIP_BYTES) {
    add(HIGH, 'size_clipped',
      `The HTML is ${Math.round(size / 1024)} KB. Gmail clips messages over ~102 KB behind a "View entire message" link — which hides your unsubscribe footer and tanks measured engagement.`,
      'Cut inline styling repetition, reduce the number of blocks, or split into two emails.');
  } else if (size > GMAIL_CLIP_BYTES * 0.8) {
    add(MED, 'size_near_clip',
      `The HTML is ${Math.round(size / 1024)} KB, within 20% of Gmail's ~102 KB clip threshold.`,
      'Trim a few blocks now so small future edits don\'t push it over.');
  }

  // ── Images ────────────────────────────────────────────────────────────────
  const imgTags = H.match(/<img\b[^>]*>/gi) || [];
  const imgs = imgTags.map(attrs).filter(a => !/width\s*=\s*["']?1["']?/i.test(JSON.stringify(a)));
  const realImgs = imgTags
    .map(t => ({ raw: t, a: attrs(t) }))
    .filter(({ a }) => !(String(a.width) === '1' && String(a.height) === '1')); // ignore tracking pixels

  const body = visibleText(H);
  const words = body ? body.split(/\s+/).length : 0;

  if (realImgs.length > 0 && words < 30) {
    add(HIGH, 'image_only',
      `This email is essentially one big image (${realImgs.length} image${realImgs.length > 1 ? 's' : ''}, only ${words} words of text).`,
      'Image-only emails are a top spam signal and are unreadable when images are blocked by default — which is the default in Outlook. Put the core message in real text blocks.');
  } else if (realImgs.length > 0 && words < 100 && words < 40 * realImgs.length) {
    add(MED, 'low_text',
      `Only ${words} words of text against ${realImgs.length} image${realImgs.length > 1 ? 's' : ''}.`,
      'Aim for a body that still makes sense with images switched off.');
  }

  const noAlt = realImgs.filter(({ a }) => !String(a.alt || '').trim());
  if (noAlt.length) {
    add(MED, 'img_no_alt',
      `${noAlt.length} image${noAlt.length > 1 ? 's have' : ' has'} no alt text.`,
      'Alt text is what recipients see before images load, and its absence is a small negative signal. Set it in the builder\'s image panel.');
  }

  const insecureImgs = realImgs.filter(({ a }) => /^http:\/\//i.test(String(a.src || '')));
  if (insecureImgs.length) {
    add(HIGH, 'img_insecure',
      `${insecureImgs.length} image${insecureImgs.length > 1 ? 's are' : ' is'} loaded over plain http://.`,
      'Serve every image over https:// — some clients refuse to load mixed content, so those images silently vanish.');
  }

  const localImgs = realImgs.filter(({ a }) =>
    /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(String(a.src || '')) ||
    /-git-|\.vercel\.app\/_next\/image/i.test(String(a.src || '')));
  if (localImgs.length) {
    add(HIGH, 'img_unreachable',
      `${localImgs.length} image URL${localImgs.length > 1 ? 's point' : ' points'} at localhost or a preview deployment.`,
      'Those will be broken for every recipient. Host images on a stable public URL.');
  }

  const imgHosts = new Set(realImgs.map(({ a }) => registrable(hostOf(a.src || ''))).filter(Boolean));
  if (own) imgHosts.delete(own);
  if (imgHosts.size > 2) {
    add(LOW, 'img_many_hosts',
      `Images are pulled from ${imgHosts.size} different domains (${[...imgHosts].join(', ')}).`,
      'Consolidate onto your own domain or one CDN — scattered asset hosts look like a template scraped together.');
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const links = [];
  let am;
  while ((am = anchorRe.exec(H))) {
    const a = attrs('<a ' + am[1] + '>');
    links.push({ href: String(a.href || ''), label: visibleText(am[2]) });
  }

  const shortened = links.filter(l => SHORTENERS.includes(registrable(hostOf(l.href))));
  if (shortened.length) {
    add(HIGH, 'link_shortener',
      `${shortened.length} link${shortened.length > 1 ? 's use' : ' uses'} a URL shortener (${[...new Set(shortened.map(l => registrable(hostOf(l.href))))].join(', ')}).`,
      'Shorteners hide the destination and are heavily penalised because spammers rely on them. Link the real URL.');
  }

  const ipLinks = links.filter(l => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(l.href));
  if (ipLinks.length) {
    add(HIGH, 'link_raw_ip',
      `${ipLinks.length} link${ipLinks.length > 1 ? 's point' : ' points'} at a bare IP address.`,
      'Use a hostname. Bare-IP links are treated as near-certain phishing.');
  }

  // Anchor text showing one domain while href goes somewhere else — classic phishing shape.
  const mismatched = links.filter(l => {
    const shown = hostOf(l.label) || (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l.label.trim()) ? l.label.trim().toLowerCase() : '');
    if (!shown) return false;
    const target = hostOf(l.href);
    return target && registrable(shown) !== registrable(target);
  });
  if (mismatched.length) {
    add(HIGH, 'link_mismatch',
      `${mismatched.length} link${mismatched.length > 1 ? 's show' : ' shows'} one domain as its text but points elsewhere (e.g. text "${mismatched[0].label.slice(0, 40)}" → ${hostOf(mismatched[0].href)}).`,
      'Make the visible text match the destination, or use descriptive words instead of a URL.');
  }

  if (links.length > 20) {
    add(MED, 'link_count',
      `${links.length} links in one email.`,
      'Marketing emails with a wall of links score badly. One clear primary call to action converts better anyway.');
  }

  if (links.length === 0 && words > 40) {
    add(LOW, 'link_none',
      'No links at all.',
      'Not a spam risk, but worth confirming this is intentional — a marketing email with no call to action is unusual.');
  }

  const linkHosts = new Set(links.map(l => registrable(hostOf(l.href))).filter(Boolean));
  if (own) linkHosts.delete(own);
  if (linkHosts.size > 4) {
    add(LOW, 'link_many_hosts',
      `Links go to ${linkHosts.size} different external domains.`,
      'Filters read scattered outbound domains as aggregated/affiliate content.');
  }

  // Assets or links on a *.vercel.app host while you send from your own domain. Mild, but
  // it's free to fix with a CNAME and it makes every URL in the email first-party.
  if (own) {
    const vercelHosts = [...new Set(
      [...realImgs.map(({ a }) => hostOf(a.src || '')), ...links.map(l => hostOf(l.href))]
        .filter(h => /\.vercel\.app$/i.test(h))
    )];
    if (vercelHosts.length) {
      add(MED, 'offdomain_assets',
        `Tracking or asset URLs are on ${vercelHosts.join(', ')} while you send from ${own}.`,
        `Point a subdomain such as mail.${own} at the Vercel app and set APP_URL to it. Every link and the tracking pixel then sit on your own domain, which both looks legitimate and keeps engagement signals attached to your reputation instead of a shared vercel.app host.`);
    }
  }

  // ── Text part ─────────────────────────────────────────────────────────────
  const textWords = T.trim() ? T.trim().split(/\s+/).length : 0;
  if (!T.trim()) {
    add(HIGH, 'text_missing',
      'The plain-text part is empty.',
      'A multipart/alternative message whose text part is blank is a well-known spam pattern. lib/marketing.js derives text from the design automatically, so an empty result usually means the design has no real text blocks.');
  } else if (words > 60 && textWords < words * 0.25) {
    add(MED, 'text_thin',
      `The plain-text part (${textWords} words) is much shorter than the HTML (${words} words).`,
      'Filters compare the two parts and penalise big mismatches. Usually means content is trapped in images.');
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────────
  if (!footerAdded && !/unsubscrib/i.test(H)) {
    add(HIGH, 'no_unsubscribe',
      'No unsubscribe link found and the automatic footer is switched off.',
      'Commercial email needs a working opt-out — both legally and because people who can\'t unsubscribe hit "Report spam" instead.');
  }

  // ── Structural nasties ────────────────────────────────────────────────────
  if (/<script\b/i.test(H)) {
    add(HIGH, 'has_script',
      'The HTML contains a <script> tag.',
      'Every mail client strips scripts, and their presence alone raises spam scores. Remove it from any raw-HTML block.');
  }
  if (/<iframe\b/i.test(H)) {
    add(HIGH, 'has_iframe',
      'The HTML contains an <iframe>.',
      'Iframes are stripped by mail clients and treated as an attack signal.');
  }
  if (/<form\b/i.test(H)) {
    add(MED, 'has_form',
      'The HTML contains a <form>.',
      'Forms don\'t work in most mail clients. Link out to a hosted form instead.');
  }

  // Hidden text — real content behind display:none / font-size:0 / white-on-white.
  // The tracking pixel is width=1 height=1 and already excluded above.
  //
  // Two things matter for accuracy here:
  //   1. <\/\1> backreferences the OPENING TAG NAME, so a match ends at that element's
  //      own closing tag. Without it the regex ran on to the next `</` anywhere in the
  //      document, and a 1px spacer holding only &nbsp; would drag in the following
  //      markup until it passed the length threshold. That produced false positives on
  //      every well-built email (hairlines, spacer cells, styled bullets).
  //   2. The length test runs on VISIBLE TEXT — tags stripped, entities collapsed — so
  //      spacing characters never count as words. A one-line preheader is also allowed,
  //      because every real sender uses one and it summarises the visible copy rather
  //      than contradicting it.
  const PREHEADER_MAX = 200;

  // Visible characters appearing BEFORE a given offset. A preheader sits ahead of all
  // visible copy; an evasion payload sits behind it. That distinction is what we test,
  // rather than a raw byte offset, which is trivially defeated by padding.
  const visibleBefore = (idx) => H.slice(0, idx)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&zwnj;|&shy;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

  let preheaderAllowed = true;   // at most one, and only if nothing visible precedes it

  const hiddenBlocks = (H.match(/<(\w+)\b[^>]*style="[^"]*(?:display\s*:\s*none|font-size\s*:\s*0(?!\.|\d)|visibility\s*:\s*hidden)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi) || [])
    .filter(chunk => !/width=["']?1["']?/i.test(chunk))
    .map(chunk => {
      const inner = chunk
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;|&zwnj;|&shy;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { chunk, inner };
    })
    .filter(({ inner }) => inner.length >= 25)
    .filter(({ chunk, inner }) => {
      const isPreheader = preheaderAllowed
        && inner.length <= PREHEADER_MAX
        && visibleBefore(H.indexOf(chunk)) < 10;
      if (isPreheader) { preheaderAllowed = false; return false; }
      return true;
    });

  if (hiddenBlocks.length) {
    const sample = hiddenBlocks[0].inner.slice(0, 60);
    add(HIGH, 'hidden_text',
      `There appears to be hidden text (display:none, font-size:0 or visibility:hidden wrapping real content): "${sample}${hiddenBlocks[0].inner.length > 60 ? '…' : ''}"`,
      'Hidden text is treated as deliberate filter evasion and is one of the fastest ways to get a domain flagged. If a raw-HTML block came from another template, check it. Spacer elements and a single short preheader are not flagged.');
  }

  // ── Tone / formatting ─────────────────────────────────────────────────────
  const lower = body.toLowerCase();
  const hits = PHRASES.filter(p => lower.includes(p));
  if (hits.length >= 3) {
    add(MED, 'phrases',
      `Several high-scoring marketing phrases: ${hits.slice(0, 5).map(h => `"${h}"`).join(', ')}${hits.length > 5 ? `, +${hits.length - 5} more` : ''}.`,
      'Any one is fine; a cluster reads as a template blast. Rewrite in the voice a trainer would actually use.');
  } else if (hits.length) {
    add(LOW, 'phrases_few',
      `Contains ${hits.map(h => `"${h}"`).join(', ')}.`,
      'Low risk on its own — just be aware it\'s a scored phrase.');
  }

  const bangs = (body.match(/!/g) || []).length;
  if (bangs >= 4) {
    add(MED, 'exclamations',
      `${bangs} exclamation marks in the body.`,
      'Cut it to one or none.');
  }

  const ACRONYMS = ['ASAP', 'FAQ', 'USA', 'HTML', 'PDF', 'USD', 'AKC', 'CGC', 'EST', 'PST', 'CST', 'MST'];
  const shouty = body.match(/\b[A-Z]{4,}\b/g) || [];
  const shoutyReal = shouty.filter(w => !ACRONYMS.includes(w));
  if (shoutyReal.length >= 3) {
    add(MED, 'all_caps',
      `${shoutyReal.length} words in ALL CAPS (${[...new Set(shoutyReal)].slice(0, 4).join(', ')}).`,
      'Use bold in the builder instead of capitals.');
  }

  if (/\$\s?\d[\d,]*\s?(\.\d\d)?\s*(off|discount)?[!]{2,}|\${3,}/i.test(body)) {
    add(MED, 'money_shout',
      'Aggressive currency formatting (repeated $ signs or a price followed by multiple exclamation marks).',
      'State the offer plainly.');
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  return { score: scoreOf(f), findings: f };
}

/** Any single high-severity finding caps the score below 70 so it never renders green. */
function scoreOf(findings) {
  const weight = { high: 20, medium: 8, low: 3 };
  let score = Math.max(0, 100 - findings.reduce((n, x) => n + weight[x.level], 0));
  if (findings.some(x => x.level === 'high')) score = Math.min(score, 69);
  return score;
}

/**
 * Lint a subject line. Separate from checkBody because the subject lives on the campaign
 * step, not on the design.
 * @returns {{ score:number, findings:Array }}
 */
export function checkSubject(subject) {
  const f = [];
  const add = (level, code, message, fix) => f.push({ level, code, message, fix });
  const s = String(subject || '');

  if (!s.trim()) {
    add(HIGH, 'subject_empty', 'No subject line.', 'Blank subjects are filtered almost universally.');
    return { score: 0, findings: f };
  }

  if (/^\s*(re|fw|fwd)\s*:/i.test(s)) {
    add(HIGH, 'subject_fake_reply',
      'The subject starts with "Re:" or "Fwd:" on an email that isn\'t a reply.',
      'This is deceptive-header territory under CAN-SPAM and filters detect it easily. Remove it.');
  }

  if (s.length > 70) {
    add(LOW, 'subject_long',
      `${s.length} characters — mobile clients show roughly the first 35–40.`,
      'Front-load the point.');
  }

  const bangs = (s.match(/!/g) || []).length;
  if (bangs >= 2) add(MED, 'subject_bangs', `${bangs} exclamation marks in the subject.`, 'Use at most one.');

  const caps = s.match(/\b[A-Z]{4,}\b/g) || [];
  if (caps.length) add(MED, 'subject_caps', `ALL CAPS in the subject (${[...new Set(caps)].join(', ')}).`, 'Sentence case performs better and scores better.');

  const emoji = (s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (emoji > 2) add(LOW, 'subject_emoji', `${emoji} emoji in the subject.`, 'One is a hook; three is a blast.');

  const lower = s.toLowerCase();
  const hits = PHRASES.filter(p => lower.includes(p));
  if (hits.length) add(MED, 'subject_phrases', `Scored phrase in the subject: ${hits.map(h => `"${h}"`).join(', ')}.`, 'Subject-line phrases weigh more than body ones. Rephrase.');

  if (/\bfree\b/i.test(s.slice(0, 12))) {
    add(LOW, 'subject_free_first', '"Free" appears at the very start of the subject.', 'Move it later in the line, or drop it.');
  }

  if (/\{\{\s*[a-z_]+\s*\}\}/i.test(s) && !/\{\{\s*firstname\s*\}\}/i.test(s)) {
    add(MED, 'subject_token_risk',
      'The subject uses a token other than {{firstname}}.',
      'Only {{firstname}} has a safe fallback ("there"). Others render empty, which produces things like "Hi , about your booking".');
  }

  return { score: scoreOf(f), findings: f };
}

/** Convenience: run both, merge, return one score. */
export function checkAll({ html, text, subject, footerAdded = true, ownDomain = '' }) {
  const b = checkBody({ html, text, footerAdded, ownDomain });
  const s = subject === undefined ? { score: 100, findings: [] } : checkSubject(subject);
  const findings = [...s.findings, ...b.findings];
  return { score: scoreOf(findings), findings };
}
