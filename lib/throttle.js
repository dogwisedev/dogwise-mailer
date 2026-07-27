// lib/throttle.js — per-sender pacing for marketing sends only.
//
// Two problems this solves:
//
//  1. Volume. Gmail/Workspace allows ~2,000 API-sent messages per user per day, but the
//     limit that matters is behavioural: a mailbox that sends 12 personal emails a day for
//     a year and then sends 600 identical HTML emails in one afternoon looks compromised.
//
//  2. Burst. Your cron pulls up to 200 due contacts every 5 minutes. Without pacing, a
//     freshly enrolled marketing campaign fires everything it can in one tick.
//
// Over-cap sends are DEFERRED, not dropped: we return { ok:false } and lib/process.js
// leaves dw_next_send alone, so the next cron tick retries. That's the same mechanism the
// send-window gate already uses, so nothing new can strand a contact mid-sequence.
//
// Transactional/1:1 email is not touched by any of this — the gate is only consulted for
// steps with format:'design'.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).result;
}

const DAILY_CAP = parseInt(process.env.MARKETING_DAILY_CAP || '400', 10);
const PER_TICK = parseInt(process.env.MARKETING_PER_TICK || '20', 10);

/**
 * Warm-up ramp. A brand-new sending pattern should start small and grow, or the first
 * big send defines your reputation before you have any positive engagement history.
 * Set MARKETING_WARMUP_START=2026-08-01 and the cap climbs from 25/day to the full
 * DAILY_CAP over about two weeks. Leave it unset to skip the ramp entirely.
 */
const RAMP = [25, 40, 60, 90, 130, 180, 240, 300, 360];

export function effectiveDailyCap(now = new Date()) {
  const start = process.env.MARKETING_WARMUP_START;
  if (!start) return DAILY_CAP;
  const t0 = Date.parse(start + 'T00:00:00Z');
  if (isNaN(t0)) return DAILY_CAP;
  const days = Math.floor((now.getTime() - t0) / 86400000);
  if (days < 0) return RAMP[0];
  if (days >= RAMP.length) return DAILY_CAP;
  return Math.min(DAILY_CAP, RAMP[days]);
}

function dayKey(sender, now) {
  const d = now.toISOString().slice(0, 10);
  return `dogwise:cap:${sender.toLowerCase()}:${d}`;
}

function tickKey(sender, now) {
  const bucket = Math.floor(now.getTime() / (5 * 60 * 1000));
  return `dogwise:pace:${sender.toLowerCase()}:${bucket}`;
}

/**
 * May `senderEmail` send one more marketing email right now?
 * Read-only — call recordMarketingSend() after a send actually succeeds.
 * Fails OPEN: if Redis is unreachable we allow the send rather than stall the sequence.
 *
 * @returns {Promise<{ok:boolean, reason?:string, sentToday?:number, cap?:number}>}
 */
export async function marketingGate(senderEmail, now = new Date()) {
  if (!URL_ || !TOKEN) return { ok: true };
  try {
    const cap = effectiveDailyCap(now);
    const [dayRaw, tickRaw] = await Promise.all([
      redis(['GET', dayKey(senderEmail, now)]),
      redis(['GET', tickKey(senderEmail, now)])
    ]);
    const sentToday = parseInt(dayRaw || '0', 10);
    const sentTick = parseInt(tickRaw || '0', 10);

    if (sentToday >= cap) {
      return { ok: false, reason: `daily marketing cap reached for ${senderEmail} (${sentToday}/${cap})`, sentToday, cap };
    }
    if (sentTick >= PER_TICK) {
      return { ok: false, reason: `pacing — ${senderEmail} already sent ${sentTick} marketing emails in this 5-minute window`, sentToday, cap };
    }
    return { ok: true, sentToday, cap };
  } catch {
    return { ok: true }; // fail open
  }
}

/** Record one successful marketing send. Never throws. */
export async function recordMarketingSend(senderEmail, now = new Date()) {
  if (!URL_ || !TOKEN) return;
  try {
    const dk = dayKey(senderEmail, now), tk = tickKey(senderEmail, now);
    await redis(['INCR', dk]);
    await redis(['EXPIRE', dk, 172800]);   // 48h — survives timezone boundaries
    await redis(['INCR', tk]);
    await redis(['EXPIRE', tk, 900]);      // 15m
  } catch { /* counting is best-effort; never block a send on it */ }
}

/** For the dashboard: today's marketing volume per sender. */
export async function todayVolume(senderEmails, now = new Date()) {
  if (!URL_ || !TOKEN) return {};
  const out = {};
  const cap = effectiveDailyCap(now);
  await Promise.all((senderEmails || []).map(async e => {
    try {
      const v = await redis(['GET', dayKey(e, now)]);
      out[e] = { sent: parseInt(v || '0', 10), cap };
    } catch { out[e] = { sent: 0, cap }; }
  }));
  return out;
}
