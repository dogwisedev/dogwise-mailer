// lib/store.js — campaign storage in Upstash Redis (Vercel Marketplace), seeded from campaigns.json
import seed from '../campaigns.json' with { type: 'json' };

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'dogwise:campaigns';

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

export function storeConfigured() {
  return Boolean(URL_ && TOKEN);
}

/** All campaigns: { key: { label, steps: [...] } }. Falls back to campaigns.json if no DB configured. */
export async function getCampaigns() {
  if (!storeConfigured()) return seed;
  const raw = await redis(['GET', KEY]);
  if (!raw) {
    // First run — seed from campaigns.json so the welcome email always exists
    await redis(['SET', KEY, JSON.stringify(seed)]);
    return seed;
  }
  const campaigns = JSON.parse(raw);
  // Top-up: seed campaigns that don't exist yet get added (never overwrites edits)
  let added = false;
  for (const [key, val] of Object.entries(seed)) {
    if (!campaigns[key]) { campaigns[key] = val; added = true; }
  }
  if (added) await redis(['SET', KEY, JSON.stringify(campaigns)]);
  return campaigns;
}

export async function saveCampaigns(campaigns) {
  if (!storeConfigured()) throw new Error('No database configured — add Upstash Redis in Vercel (Storage tab)');
  await redis(['SET', KEY, JSON.stringify(campaigns)]);
  return campaigns;
}

// ── Folders ─────────────────────────────────────────────────────────────────
// Global (DB-backed) folders for organising the left panel. An ordered list of
// { id, name }; a campaign belongs to a folder via its own `folder` field (the
// folder id), so folders and membership both persist server-side, for everyone.
const FOLDERS_KEY = 'dogwise:folders';

/** Ordered [{ id, name }]. Empty array if none / no DB. */
export async function getFolders() {
  if (!storeConfigured()) return [];
  const raw = await redis(['GET', FOLDERS_KEY]);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

export async function saveFolders(folders) {
  if (!storeConfigured()) throw new Error('No database configured — add Upstash Redis in Vercel (Storage tab)');
  const clean = (Array.isArray(folders) ? folders : [])
    .filter(f => f && f.id && String(f.name || '').trim())
    .map(f => ({ id: String(f.id), name: String(f.name).trim() }));
  await redis(['SET', FOLDERS_KEY, JSON.stringify(clean)]);
  return clean;
}
