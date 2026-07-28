// lib/metrics.js — aggregated counters for the analytics dashboard and trigger rules.
//
// WHY THIS EXISTS SEPARATELY FROM activity.js
// The activity list is LTRIMmed to 2,000 entries, which is a few hours of volume. It is a
// live feed, not an analytics store. Anything you want to chart over weeks has to be
// counted at write time. These are those counters.
//
// KEYS
//   dwm:m:<campaign>:<yyyymmdd>   HASH  "<step>:<metric>" -> n     per-step daily funnel
//   dwm:hod:<campaign>            HASH  "<metric>:<hourUTC>" -> n  hour-of-day heatmap
//   dwm:tto:<campaign>            HASH  "<bucket>" -> n            time from send to open
//   dwm:lk:<campaign>             HASH  "<step>|<url>" -> n        clicks per link
//   dwm:o:<sendId>                HASH  n / first / last           open count per send
//   dwm:cl:<sendId>               HASH  "<i>" -> n, "_n" -> total   clicks per send
//   dwm:links:<sendId>            JSON  [{ url, label }]           link registry
//   dwm:tq                        LIST  queued trigger evaluations
//
// A NOTE ON OPEN COUNTS. Apple Mail Privacy Protection prefetches images on delivery, so
// a first "open" may be a machine. Gmail proxies and caches images, so repeat opens often
// never reach us. Treat open counts as directional heat, never as proof a human read it.
// Clicks are the trustworthy signal: prefetchers do not click.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TTL_DAYS = 400;
const SEND_TTL = 90 * 86400;

export function metricsConfigured() { return Boolean(URL_ && TOKEN); }

async function redis(cmd) {
  if (!metricsConfigured()) return null;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    if (!res.ok) return null;
    return (await res.json()).result;
  } catch { return null; }
}

/** Upstash pipeline: one HTTP round trip for many commands. */
async function pipe(cmds) {
  if (!metricsConfigured() || !cmds.length) return null;
  try {
    const res = await fetch(`${URL_}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds)
    });
    if (!res.ok) return null;
    return (await res.json()).map(r => r?.result);
  } catch { return null; }
}

export function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Inclusive list of yyyymmdd strings, oldest first. */
export function dayRange(days = 14, endMs = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(endMs - i * 86400000));
  return out;
}

function ttoBucket(ms) {
  const m = ms / 60000;
  if (m < 15) return '0-15m';
  if (m < 60) return '15-60m';
  if (m < 240) return '1-4h';
  if (m < 1440) return '4-24h';
  if (m < 4320) return '1-3d';
  return '3d+';
}

/**
 * Record one funnel event. Called on every send, open, click, reply, completion.
 * @param {string} metric sent|opened|open_hit|clicked|click_hit|replied|completed|skipped
 */
export async function bump({ campaign, step, metric, at = Date.now() }) {
  if (!campaign || !metric) return;
  const d = dayKey(at);
  const hour = new Date(at).getUTCHours();
  const cmds = [
    ['HINCRBY', `dwm:m:${campaign}:${d}`, `${step ?? 0}:${metric}`, '1'],
    ['EXPIRE', `dwm:m:${campaign}:${d}`, String(TTL_DAYS * 86400)],
    ['HINCRBY', `dwm:hod:${campaign}`, `${metric}:${hour}`, '1']
  ];
  await pipe(cmds);
}

/**
 * Count an open. Returns { n, first } so callers can tell a first open from a repeat
 * without a second round trip.
 */
export async function countOpen(sendId, at = Date.now()) {
  if (!sendId) return { n: 0, first: false };
  const k = `dwm:o:${sendId}`;
  const r = await pipe([
    ['HINCRBY', k, 'n', '1'],
    ['HSETNX', k, 'first', String(at)],
    ['HSET', k, 'last', String(at)],
    ['EXPIRE', k, String(SEND_TTL)],
    ['HGET', k, 'first']
  ]);
  const n = Number(r?.[0] ?? 0);
  return { n, first: n === 1, firstAt: Number(r?.[4] ?? at) };
}

/** Record time-from-send-to-first-open in coarse buckets. */
export async function recordTimeToOpen(campaign, sentAt, openedAt) {
  if (!campaign || !sentAt) return;
  const delta = openedAt - sentAt;
  if (delta < 0) return;
  await redis(['HINCRBY', `dwm:tto:${campaign}`, ttoBucket(delta), '1']);
}

/** Store the outbound links for a send so /api/c can resolve by index, not by URL. */
export async function registerLinks(sendId, links) {
  if (!sendId || !links?.length) return;
  await pipe([
    ['SET', `dwm:links:${sendId}`, JSON.stringify(links)],
    ['EXPIRE', `dwm:links:${sendId}`, String(SEND_TTL)]
  ]);
}

export async function getLinks(sendId) {
  const raw = await redis(['GET', `dwm:links:${sendId}`]);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

/**
 * Count a click. Returns { n, total, first } where n is clicks on THIS link for this
 * send and total is clicks on any link for this send.
 */
export async function countClick({ sendId, index, campaign, step, url, at = Date.now() }) {
  const k = `dwm:cl:${sendId}`;
  const r = await pipe([
    ['HINCRBY', k, String(index), '1'],
    ['HINCRBY', k, '_n', '1'],
    ['EXPIRE', k, String(SEND_TTL)],
    ...(campaign && url ? [['HINCRBY', `dwm:lk:${campaign}`, `${step ?? 0}|${url}`, '1']] : [])
  ]);
  const n = Number(r?.[0] ?? 0);
  const total = Number(r?.[1] ?? 0);
  return { n, total, first: total === 1 };
}

export async function getOpenCount(sendId) {
  const r = await redis(['HGETALL', `dwm:o:${sendId}`]);
  const o = {};
  for (let i = 0; i < (r || []).length; i += 2) o[r[i]] = r[i + 1];
  return { n: Number(o.n || 0), first: Number(o.first || 0), last: Number(o.last || 0) };
}

export async function getClickCount(sendId) {
  const r = await redis(['HGETALL', `dwm:cl:${sendId}`]);
  const o = {};
  for (let i = 0; i < (r || []).length; i += 2) o[r[i]] = Number(r[i + 1]);
  return { total: o._n || 0, perLink: o };
}

// ── Trigger queue ──────────────────────────────────────────────────────────
// The pixel and click endpoints must return fast, so rule evaluation is deferred to
// the cron rather than done inline.

export async function queueTrigger(job) {
  await pipe([
    ['LPUSH', 'dwm:tq', JSON.stringify({ at: Date.now(), ...job })],
    ['LTRIM', 'dwm:tq', '0', '4999']
  ]);
}

/** Pop up to n queued jobs. */
export async function drainTriggers(n = 50) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const raw = await redis(['RPOP', 'dwm:tq']);
    if (!raw) break;
    try { out.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return out;
}

// ── Read side, for /api/analytics ──────────────────────────────────────────

function hashToObj(arr) {
  const o = {};
  for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
  return o;
}

/**
 * Per-step daily funnel for one campaign.
 * @returns {{ days: string[], steps: object, totals: object }}
 */
export async function campaignFunnel(campaign, days = 14) {
  const range = dayRange(days);
  const res = await pipe(range.map(d => ['HGETALL', `dwm:m:${campaign}:${d}`])) || [];

  const byDay = {};
  const steps = {};
  const totals = {};

  range.forEach((d, i) => {
    const o = hashToObj(res[i]);
    byDay[d] = {};
    for (const [field, n] of Object.entries(o)) {
      const [step, metric] = field.split(':');
      byDay[d][metric] = (byDay[d][metric] || 0) + n;
      steps[step] = steps[step] || {};
      steps[step][metric] = (steps[step][metric] || 0) + n;
      totals[metric] = (totals[metric] || 0) + n;
    }
  });

  return { campaign, days: range, byDay, steps, totals };
}

export async function campaignLinks(campaign, limit = 20) {
  const o = hashToObj(await redis(['HGETALL', `dwm:lk:${campaign}`]));
  return Object.entries(o)
    .map(([field, clicks]) => {
      const idx = field.indexOf('|');
      return { step: Number(field.slice(0, idx)) || 0, url: field.slice(idx + 1), clicks };
    })
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, limit);
}

export async function campaignHourOfDay(campaign) {
  const o = hashToObj(await redis(['HGETALL', `dwm:hod:${campaign}`]));
  const grid = {};
  for (const [field, n] of Object.entries(o)) {
    const [metric, hour] = field.split(':');
    grid[metric] = grid[metric] || Array(24).fill(0);
    grid[metric][Number(hour)] = n;
  }
  return grid;
}

export async function campaignTimeToOpen(campaign) {
  const order = ['0-15m', '15-60m', '1-4h', '4-24h', '1-3d', '3d+'];
  const o = hashToObj(await redis(['HGETALL', `dwm:tto:${campaign}`]));
  return order.map(bucket => ({ bucket, n: o[bucket] || 0 }));
}
