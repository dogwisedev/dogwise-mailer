// lib/activity.js — send/open/reply event log in Upstash Redis
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const LIST = 'dwm:activity';

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

/** Log an event: { type: 'sent'|'opened'|'replied'|'error', contact, campaign, step, sender, detail } */
export async function logEvent(evt) {
  try {
    await redis(['LPUSH', LIST, JSON.stringify({ t: Date.now(), ...evt })]);
    await redis(['LTRIM', LIST, '0', '1999']);
  } catch { /* activity logging never blocks sends */ }
}

export async function getEvents(n = 300) {
  const raw = await redis(['LRANGE', LIST, '0', String(n - 1)]);
  return (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

/** Store per-send metadata so the open pixel can identify the send without PII in the URL. */
export async function rememberSend(sendId, meta) {
  await redis(['SET', `dwm:send:${sendId}`, JSON.stringify(meta), 'EX', String(90 * 86400)]);
}

export async function lookupSend(sendId) {
  const raw = await redis(['GET', `dwm:send:${sendId}`]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** True only the first time this send is opened (dedupes multi-opens). */
export async function markOpenedOnce(sendId) {
  const r = await redis(['SET', `dwm:open:${sendId}`, '1', 'NX', 'EX', String(90 * 86400)]);
  return r === 'OK';
}

/** Timestamp of the last send to a contact (for reply-search window). */
export async function rememberLastSend(contactId) {
  await redis(['SET', `dwm:last:${contactId}`, String(Date.now()), 'EX', String(120 * 86400)]);
}

export async function getLastSend(contactId) {
  const raw = await redis(['GET', `dwm:last:${contactId}`]);
  return raw ? parseInt(raw, 10) : null;
}

/** Persistent all-time counters, total + per-campaign. */
export async function bumpStat(campaign, type) {
  try {
    await redis(['HINCRBY', 'dwm:stats:total', type, '1']);
    if (campaign) {
      await redis(['HINCRBY', `dwm:stats:camp:${campaign}`, type, '1']);
      await redis(['SADD', 'dwm:stats:campaigns', campaign]);
    }
  } catch { /* stats never block */ }
}

export async function getAllTimeStats() {
  const toObj = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = parseInt(arr[i + 1], 10) || 0; return o; };
  const total = toObj(await redis(['HGETALL', 'dwm:stats:total']));
  const names = (await redis(['SMEMBERS', 'dwm:stats:campaigns'])) || [];
  const perCampaign = {};
  for (const name of names) perCampaign[name] = toObj(await redis(['HGETALL', `dwm:stats:camp:${name}`]));
  return { total, perCampaign };
}

/** True if this contact hasn't been reply-checked in the last `hours` (and marks it checked). */
export async function shouldReplyCheck(contactId, hours = 4) {
  const r = await redis(['SET', `dwm:rchk:${contactId}`, '1', 'NX', 'EX', String(hours * 3600)]);
  return r === 'OK';
}
