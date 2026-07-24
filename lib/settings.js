// lib/settings.js — app settings (per-sender booking links etc.) in Redis, 60s in-memory cache
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'dwm:settings';

let cache = null, cacheAt = 0;

async function redis(cmd) {
  if (!URL_ || !TOKEN) return null;
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) return null;
  return (await res.json()).result;
}

const DEFAULTS = { senderLinks: {}, senderLinkFallback: '', smsNumbers: {} };

/**
 * App settings:
 *   { senderLinks:       { "anita@...": "https://calendly.com/..." },
 *     senderLinkFallback: "https://...",
 *     smsNumbers:        { "<hubspotOwnerId>": { "East Coast": "PN…", "Texas": "PN…", … } } }
 */
export async function getSettings() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const raw = await redis(['GET', KEY]);
  cache = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  cacheAt = Date.now();
  return cache;
}

export async function saveSettings(settings) {
  await redis(['SET', KEY, JSON.stringify(settings)]);
  cache = settings; cacheAt = Date.now();
  return settings;
}

/** Resolve the booking link for a sender email — personal link, else fallback, else ''. */
export async function bookingLinkFor(senderEmail) {
  const s = await getSettings();
  return s.senderLinks?.[String(senderEmail || '').toLowerCase()] || s.senderLinkFallback || '';
}

/**
 * OpenPhone number id (PN…) to text FROM, for a given HubSpot owner + region.
 * Exact person+region match only — returns '' if that owner has no number mapped for
 * that region (caller then withholds the text rather than using a wrong-region line).
 */
export async function smsNumberFor(ownerId, region) {
  const s = await getSettings();
  const forOwner = s.smsNumbers?.[String(ownerId)] || null;
  if (!forOwner) return '';
  // Exact person + region match only — never text a lead from another region's line.
  return String(forOwner[region] || '').trim();
}
