// lib/designs.js — storage for drag-and-drop marketing designs.
//
// Deliberately NOT stored inside `dogwise:campaigns`. That key is read on every cron
// sweep and rewritten in full on every campaign save; a 60 KB rendered marketing email
// per step would bloat it and risk Upstash's per-value limit. Instead each design gets
// its own key and a step just references it by id.
//
//   dogwise:designs            → ordered index [{ id, name, updatedAt }]
//   dogwise:design:<id>        → { id, name, design, html, text, updatedAt }
//
// `design` is the EmailBuilder.js document JSON (for re-editing).
// `html` / `text` are the pre-rendered output, produced in the browser at save time.
// That is what keeps the server dependency-free — no React on the send path.

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

/** Ordered [{ id, name, updatedAt }] — light enough to load in the dashboard. */
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

export async function saveDesign({ id, name, design, html, text, score }) {
  if (!designsConfigured()) throw new Error('No database configured — add Upstash Redis in Vercel (Storage tab)');
  if (!/^[a-z0-9_-]{3,60}$/.test(String(id || ''))) throw new Error('Design id must be 3–60 chars: lowercase letters, numbers, _ or -');
  if (!String(name || '').trim()) throw new Error('Design needs a name');
  if (!design || typeof design !== 'object') throw new Error('Design document missing');
  if (!String(html || '').trim()) throw new Error('Design has no rendered HTML — save from the builder, not by hand');

  const record = {
    id: String(id),
    name: String(name).trim(),
    design,
    html: String(html),
    text: String(text || ''),
    score: Number.isFinite(score) ? score : null,
    updatedAt: Date.now()
  };

  await redis(['SET', designKey(record.id), JSON.stringify(record)]);

  const index = await listDesigns();
  const next = index.filter(d => d.id !== record.id);
  next.unshift({ id: record.id, name: record.name, updatedAt: record.updatedAt, score: record.score });
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
 * Which campaign steps still point at a design? Called before delete so the UI can
 * warn instead of silently breaking a live sequence.
 * `campaigns` is the object from lib/store.js getCampaigns().
 */
export function designUsage(campaigns, id) {
  const uses = [];
  for (const [key, c] of Object.entries(campaigns || {})) {
    (c.steps || []).forEach((s, i) => {
      if (s.designId === id) uses.push({ campaign: key, label: c.label, step: i + 1 });
    });
  }
  return uses;
}
