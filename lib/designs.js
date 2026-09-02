// lib/designs.js — storage for marketing email designs.
//
//   dogwise:designs            → ordered index [{ id, name, updatedAt, score, source }]
//   dogwise:design:<id>        → { id, name, design, html, text, updatedAt, score, source }
//
// Two ways a record gets here:
//   1. The drag-and-drop builder (EmailBuilder.js) — sends `design` (the builder's
//      document JSON, kept so the email can be reopened and edited visually) plus
//      pre-rendered `html`/`text` produced client-side.
//   2. Raw HTML — from the MCP tools (create_marketing_design / update_marketing_design),
//      e.g. HTML written in Claude and handed straight in. There is no `design` JSON in
//      this path — nothing to reopen in the visual builder, which is expected; it's
//      still a fully valid design as far as sending is concerned, since the send path
//      (lib/marketing.js assembleMarketingEmail) only ever requires `record.html`.
//      `source: 'html'` on the record is just so the dashboard can show "not editable
//      in the builder" instead of silently opening an empty canvas.
//
// `design` is therefore OPTIONAL. `html` is always required. `text` is optional and,
// when omitted, is derived from `html` with htmlToPlainText() below rather than left
// blank — an empty plain-text part is bad for deliverability and for anyone whose mail
// client renders text-only.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const INDEX_KEY = 'dogwise:designs';
const designKey = id => `dogwise:design:${id}`;

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

export function designsConfigured() {
  return Boolean(URL_ && TOKEN);
}

/**
 * Strip real HTML down to a readable plain-text fallback. Deliberately simple (this is
 * a fallback part, not the primary rendering) — drops script/style bodies, turns block-
 * level tags into line breaks, strips remaining tags, decodes the common entities, and
 * collapses excess blank lines.
 */
export function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|h[1-6]|li|section|header|footer)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis, (_, url, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && url && t !== url ? `${t} (${url})` : (url || t);
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turn a design name into a usable id: lowercase, dashes, 3-60 chars, unique-ish suffix. */
export function slugifyDesignId(name) {
  const base = String(name || 'design')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'design';
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}

/** Ordered [{ id, name, updatedAt, score, source }] — light enough to load in the dashboard. */
export async function listDesigns() {
  if (!designsConfigured()) return [];
  const raw = await redis(['GET', INDEX_KEY]);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

/** Full record, or null. */
export async function getDesign(id) {
  if (!designsConfigured() || !id) return null;
  const raw = await redis(['GET', designKey(id)]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/**
 * Create or overwrite a design record. `design` (builder JSON) is optional — omit it
 * for an HTML-authored design. `text` is optional and derived from `html` when blank.
 */
export async function saveDesign({ id, name, design = null, html, text, score }) {
  if (!designsConfigured()) throw new Error('No database configured — add Upstash Redis in Vercel (Storage tab)');
  if (!/^[a-z0-9_-]{3,60}$/.test(String(id || ''))) throw new Error('Design id must be 3–60 chars: lowercase letters, numbers, _ or -');
  if (!String(name || '').trim()) throw new Error('Design needs a name');
  if (!String(html || '').trim()) throw new Error('Design has no HTML');

  const resolvedText = String(text || '').trim() || htmlToPlainText(html);

  const record = {
    id: String(id),
    name: String(name).trim(),
    design: design && typeof design === 'object' ? design : null,
    html: String(html),
    text: resolvedText,
    source: design && typeof design === 'object' ? 'builder' : 'html',
    score: Number.isFinite(score) ? score : null,
    updatedAt: Date.now()
  };

  await redis(['SET', designKey(record.id), JSON.stringify(record)]);

  const index = await listDesigns();
  const next = index.filter(d => d.id !== record.id);
  next.unshift({ id: record.id, name: record.name, updatedAt: record.updatedAt, score: record.score, source: record.source });
  await redis(['SET', INDEX_KEY, JSON.stringify(next)]);

  return record;
}

export async function deleteDesign(id) {
  if (!designsConfigured()) throw new Error('No database configured');
  await redis(['DEL', designKey(id)]);
  const index = await listDesigns();
  await redis(['SET', INDEX_KEY, JSON.stringify(index.filter(d => d.id !== id))]);
  return true;
}

/**
 * Which campaign steps still point at a design? Called before delete so the caller can
 * warn instead of silently breaking a live sequence.
 * `campaigns` is the object from lib/store.js getCampaigns().
 */
export function designUsage(campaigns, id) {
  const uses = [];
  for (const [key, c] of Object.entries(campaigns || {})) {
    (c.steps || []).forEach((s, i) => {
      if (s.designId === id) uses.push({ campaign: key, label: c.label, step: i + 1 });
      (s.variants || []).forEach(v => { if (v.designId === id) uses.push({ campaign: key, label: c.label, step: i + 1, variant: v.id }); });
    });
  }
  return uses;
}
