// lib/allocate.js — decides who gets processed this run.
//
// WHY THIS WAS REWRITTEN. The dashboard has offered Live / Normal / Passive since
// September, but the tiered allocator lived in lib/Allocate.js (capital A). The cron
// imports lib/allocate.js, and Vercel's filesystem is case-sensitive, so the tiered
// version was never loaded and was later deleted. Every campaign was round-robin
// equals, all drawn from ONE pool sorted by dw_next_send ascending. A bulk enrol at
// the 0 sentinel sorts to the very front of that pool, fills it, and the fixed
// three-campaign top-up then skipped the same tail campaigns every run. That is how
// a passive blast froze quotes to live customers.
//
// Tiers, served strictly in this order:
//
//   straight  Sends the moment it is enrolled (api/hook.js / api/enroll.js). The cron
//             is only the safety net, and serves these before anything else.
//   live      New leads, welcome, onboarding. Always before normal and passive.
//   normal    The default. Shares what is left, round-robin.
//   passive   Backlog, reactivation, OR. Leftover capacity only, and capped per
//             sender per day in lib/process.js so it cannot use up a mailbox.
//
// Each tier is its own HubSpot search, so a passive backlog can never occupy the
// pool a live campaign is picked from. Lower tiers are only searched while there is
// capacity left, so a quiet run costs one or two searches.
//
// Campaign fields, all optional:
//   priority   'straight' | 'live' | 'normal' | 'passive'. Absent means normal.
//   status     'paused' stops it entirely. Contacts keep their place.
//   maxPerRun  ceiling on this campaign's slots per run.

import { getDueContactsIn, getDueContactsForCampaign } from './hubspot.js';

const POOL_FACTOR = Number(process.env.ALLOC_POOL_FACTOR || 6);
const TOP_UP_LIMIT = Number(process.env.ALLOC_TOP_UP_LIMIT || 3);
const POOL_MAX = 600;   // 6 search pages, per tier

export const TIERS = ['straight', 'live', 'normal', 'passive'];
export const tierOf = (c) => (TIERS.includes(c?.priority) ? c.priority : 'normal');

export async function allocate(campaigns, totalMax) {
  const entries = Object.entries(campaigns || {});
  const paused = entries.filter(([, c]) => c?.status === 'paused').map(([k]) => k);

  const active = entries
    .filter(([, c]) => c?.status !== 'paused')
    .map(([key, c]) => ({
      key,
      tier: tierOf(c),
      cap: c?.maxPerRun === undefined || c?.maxPerRun === null || c?.maxPerRun === '' || Number(c.maxPerRun) < 0
        ? totalMax
        : Number(c.maxPerRun)
    }))
    .filter((a) => a.cap > 0);

  if (!active.length) return { contacts: [], perCampaign: {}, paused, searches: 0, starved: [] };

  const taken = {};
  const contacts = [];
  const queued = {};          // what each campaign had available, for the starved report
  let searches = 0;

  for (const tier of TIERS) {
    const remaining = totalMax - contacts.length;
    if (remaining <= 0) break;
    const inTier = active.filter((a) => a.tier === tier);
    if (!inTier.length) continue;

    const queues = new Map(inTier.map(({ key }) => [key, []]));
    const limit = Math.min(POOL_MAX, Math.max(remaining * POOL_FACTOR, 100));
    let pool = [];
    let poolFailed = false;
    try {
      pool = await getDueContactsIn(inTier.map((a) => a.key), limit);
      searches++;
    } catch { poolFailed = true; /* fall through to per-campaign top-ups */ }
    for (const contact of pool) {
      const k = contact.properties?.dw_campaign;
      if (queues.has(k)) queues.get(k).push(contact);
    }

    // A campaign with nothing in a FULL pool may have been crowded out by another
    // campaign in the same tier. Query those directly. If the pool came back short
    // of its limit, an empty queue just means nothing is due — no search needed.
    const saturated = poolFailed || pool.length >= limit;
    const empty = inTier.filter(({ key }) => !queues.get(key).length);
    if (saturated && empty.length) {
      // Straight and live are few and small: top up every one. Normal and passive
      // rotate, so the same tail campaigns are not the ones skipped every run.
      let pick = empty;
      if (tier === 'normal' || tier === 'passive') {
        const offset = Math.floor(Date.now() / 300000) % empty.length;
        pick = empty.slice(offset).concat(empty.slice(0, offset)).slice(0, TOP_UP_LIMIT);
      }
      for (const { key, cap } of pick) {
        try {
          const share = Math.max(1, Math.ceil(remaining / inTier.length));
          queues.set(key, await getDueContactsForCampaign(key, Math.min(cap, tier === 'straight' || tier === 'live' ? remaining : share)));
          searches++;
        } catch { /* one campaign's query failing must not stop the run */ }
      }
    }

    for (const { key } of inTier) queued[key] = queues.get(key).length;

    // Round-robin within the tier so no one campaign takes the head of it.
    let progressed = true;
    while (contacts.length < totalMax && progressed) {
      progressed = false;
      for (const { key, cap } of inTier) {
        if (contacts.length >= totalMax) break;
        if ((taken[key] || 0) >= cap) continue;
        const next = queues.get(key).shift();
        if (!next) continue;
        contacts.push(next);
        taken[key] = (taken[key] || 0) + 1;
        progressed = true;
      }
    }
  }

  // Anything with contacts queued that got no slots this run. Passive waiting is the
  // tier system working, so the tier travels with the name for alerting.
  const starved = active
    .filter(({ key }) => (queued[key] || 0) > 0 && !(taken[key] > 0))
    .map(({ key, tier }) => ({ key, tier }));

  return { contacts, perCampaign: taken, paused, searches, starved };
}
