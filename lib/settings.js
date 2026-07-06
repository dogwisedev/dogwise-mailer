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

/** { senderLinks: { "anita@...": "https://calendly.com/..." }, senderLinkFallback: "https://..." } */
export async function getSettings() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const raw = await redis(['GET', KEY]);
  cache = raw ? JSON.parse(raw) : { senderLinks: {}, senderLinkFallback: '' };
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
