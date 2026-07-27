// lib/bounces.js — bounce detection and a suppression list.
//
// This is the gap I'd fix first if you only fixed one thing. Right now a Gmail API send
// returns 200 as long as Google accepted the message for delivery; the bounce arrives
// later as a message in the sending rep's inbox and nothing reads it. So a dead address
// keeps getting mailed every time it appears in a sequence.
//
// Repeatedly mailing addresses that don't exist is one of the strongest negative signals
// there is — it's the fingerprint of a purchased, unvalidated list. Given Bark leads come
// in with hand-typed email addresses, you will have some.
//
// Deliberately Redis-only: no HubSpot writes, no new properties, no schema change. The
// suppression list is a Redis set and lib/process.js consults it with one call.
//
//   dogwise:suppressed          → SET of lowercased email addresses
//   dogwise:suppressed:meta     → HASH email → JSON { reason, at }
//   dogwise:bouncesweep:<owner> → last swept timestamp per mailbox

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const SET_KEY = 'dogwise:suppressed';
const META_KEY = 'dogwise:suppressed:meta';

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).result;
}

function norm(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Is this address suppressed? Fails OPEN (returns false) if Redis is unreachable —
 * a suppression check should never be able to halt the whole mailer.
 */
export async function isSuppressed(email) {
  if (!URL_ || !TOKEN || !email) return false;
  try {
    return (await redis(['SISMEMBER', SET_KEY, norm(email)])) === 1;
  } catch {
    return false;
  }
}

export async function suppress(email, reason = 'bounced') {
  if (!URL_ || !TOKEN || !email) return false;
  const e = norm(email);
  try {
    await redis(['SADD', SET_KEY, e]);
    await redis(['HSET', META_KEY, e, JSON.stringify({ reason, at: Date.now() })]);
    return true;
  } catch {
    return false;
  }
}

export async function unsuppress(email) {
  if (!URL_ || !TOKEN || !email) return false;
  const e = norm(email);
  try {
    await redis(['SREM', SET_KEY, e]);
    await redis(['HDEL', META_KEY, e]);
    return true;
  } catch {
    return false;
  }
}

/** [{ email, reason, at }] — for a dashboard panel. */
export async function listSuppressed() {
  if (!URL_ || !TOKEN) return [];
  try {
    const members = (await redis(['SMEMBERS', SET_KEY])) || [];
    if (!members.length) return [];
    const meta = (await redis(['HGETALL', META_KEY])) || [];
    // Upstash returns HGETALL as a flat [k,v,k,v,...] array
    const map = {};
    for (let i = 0; i < meta.length; i += 2) {
      try { map[meta[i]] = JSON.parse(meta[i + 1]); } catch { map[meta[i]] = {}; }
    }
    return members
      .map(e => ({ email: e, reason: map[e]?.reason || 'unknown', at: map[e]?.at || 0 }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

// ── Bounce sweep ────────────────────────────────────────────────────────────

/**
 * Pull hard-bounce notifications out of one mailbox and suppress the addresses.
 * Requires the gmail.readonly scope you already grant for reply detection, and the
 * `findBounceNotices` export added to lib/gmail.js (see patches/ANTISPAM-PATCHES.md).
 *
 * Only *hard* bounces are suppressed. "Mailbox full", "over quota" and greylisting are
 * temporary and deliberately ignored — suppressing those would lose you real leads.
 */
const HARD = [
  /address not found/i,
  /no such user/i,
  /user unknown/i,
  /recipient address rejected/i,
  /does not exist/i,
  /couldn't be found/i,
  /could not be found/i,
  /invalid recipient/i,
  /unrouteable address/i,
  /domain (?:name )?not found/i,
  /\b550\b[\s\S]{0,80}(?:5\.1\.[123]|unknown|no such)/i
];

const SOFT = [/mailbox (?:is )?full/i, /over quota/i, /quota exceeded/i, /try again later/i, /temporarily/i, /greylist/i, /4\.\d\.\d/];

/** Classify one bounce notice body. Returns 'hard' | 'soft' | 'unknown'. */
export function classifyBounce(text) {
  const t = String(text || '');
  if (SOFT.some(r => r.test(t)) && !HARD.some(r => r.test(t))) return 'soft';
  if (HARD.some(r => r.test(t))) return 'hard';
  return 'unknown';
}

/**
 * Extract the failed recipient from a bounce notice, ignoring the sender's own address
 * and Google's daemon addresses.
 */
export function extractRecipients(text, ownerEmail = '') {
  const own = norm(ownerEmail);
  const found = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const skip = /mailer-daemon|postmaster|googlemail\.com$|noreply|no-reply|@google\.com$/i;
  return [...new Set(
    found.map(norm).filter(e => e !== own && !skip.test(e))
  )];
}

/**
 * Sweep the given mailboxes for bounces newer than `sinceMs` and suppress hard failures.
 * @param {object} o
 * @param {(ownerEmail:string, sinceMs:number)=>Promise<Array<{snippet:string,subject:string}>>} o.findBounceNotices
 *        injected from lib/gmail.js so this module stays testable without Google auth
 * @param {string[]} o.ownerEmails
 * @param {number}   o.sinceMs
 */
export async function sweepBounces({ findBounceNotices, ownerEmails, sinceMs }) {
  const result = { scanned: 0, hard: 0, soft: 0, unknown: 0, suppressed: [], errors: [] };

  for (const owner of ownerEmails || []) {
    let notices = [];
    try {
      notices = await findBounceNotices(owner, sinceMs);
    } catch (e) {
      result.errors.push(`${owner}: ${e.message}`);
      continue;
    }
    for (const n of notices) {
      result.scanned++;
      const blob = `${n.subject || ''}\n${n.snippet || ''}`;
      const kind = classifyBounce(blob);
      result[kind]++;
      if (kind !== 'hard') continue;
      for (const email of extractRecipients(blob, owner)) {
        if (await suppress(email, 'hard bounce')) result.suppressed.push(email);
      }
    }
  }

  result.suppressed = [...new Set(result.suppressed)];
  return result;
}
