// lib/region.js — resolve a lead's US region + timezone from a ZIP, and decide whether
// "now" is inside a campaign's send window and its allowed days for that region.
//
// Ported from the old SMS texter and generalised: the window is now PER-CAMPAIGN
// (not the hardcoded 08:30–20:00), and day-scope is PER-STEP (Weekdays / Weekends).

const zipStateCache = {}; // cleanZip -> state abbreviation, per warm invocation

/** ZIP (any string containing 5 digits) -> US state abbreviation via zippopotam. Null if unknown. */
export async function zipToState(zip) {
  if (!zip) return null;
  const m = zip.toString().match(/\d{5}/);
  const clean = m ? m[0] : null;
  if (!clean) return null;
  if (zipStateCache[clean]) return zipStateCache[clean];
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${clean}`);
    if (!r.ok) return null;
    const d = await r.json();
    const state = d.places?.[0]?.['state abbreviation'] || null;
    if (state) zipStateCache[clean] = state;
    return state;
  } catch {
    return null;
  }
}

/** US state abbreviation -> one of our regions. */
export function stateToRegion(state) {
  if (!state) return null;
  if (['TX', 'OK', 'AR', 'KY'].includes(state)) return 'Texas';
  if (state === 'IL') return 'Illinois';
  if (state === 'FL') return 'Florida';
  if (state === 'CO') return 'Colorado';
  if (['CA', 'WA', 'AZ', 'OR', 'NV'].includes(state)) return 'West Coast';
  return 'East Coast';
}

/** First 5-digit run in a string. */
export function extractZip(str) {
  if (!str) return null;
  const m = str.toString().match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

export const REGIONS = ['East Coast', 'Florida', 'Illinois', 'Texas', 'Colorado', 'West Coast'];
export const DEFAULT_REGION = 'East Coast';

const REGION_TZ = {
  'East Coast': 'America/New_York',
  'Florida':    'America/New_York',
  'Illinois':   'America/Chicago',
  'Texas':      'America/Chicago',
  'Colorado':   'America/Denver',
  'West Coast': 'America/Los_Angeles'
};

export function timezoneForRegion(region) {
  return REGION_TZ[region] || REGION_TZ[DEFAULT_REGION];
}

/** Current { day:'Mon'..'Sun', mins:0..1439, isWeekend } in a region's local time. */
export function regionNow(region) {
  const tz = timezoneForRegion(region);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  const day = get('weekday');
  return {
    day,
    mins: (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10),
    isWeekend: day === 'Sat' || day === 'Sun'
  };
}

/**
 * Resolve a contact's region, preferring an already-stamped value.
 * Order: stamped lead_region -> contact ZIP -> fallback strings (deal location / name).
 * Returns { region, stamped }. stamped=false means the caller should persist it so we
 * don't hit zippopotam again on every cron pass.
 */
export async function resolveRegion({ stampedRegion, zip, fallbackZips = [] }) {
  if (REGIONS.includes(stampedRegion)) return { region: stampedRegion, stamped: true };
  let z = extractZip(zip);
  if (!z) for (const f of fallbackZips) { z = extractZip(f); if (z) break; }
  const state = await zipToState(z);
  const region = stateToRegion(state) || DEFAULT_REGION;
  return { region, stamped: false };
}

function fmt(mins) {
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Pure window/day check against a precomputed local time `t` (see regionNow).
 * Exported so it can be unit-tested without touching the clock.
 *   window: { startHour, endHour }  — defaults 9–16
 *   days:   { weekday, weekend }    — omitted => both allowed (back-compat)
 */
export function evaluateWindow(t, window = {}, days) {
  const startHour = Number.isFinite(window.startHour) ? window.startHour : 9;
  const endHour   = Number.isFinite(window.endHour)   ? window.endHour   : 16;

  let allowWeekday = days ? days.weekday !== false : true;
  let allowWeekend = days ? days.weekend !== false : true;
  if (days && !allowWeekday && !allowWeekend) allowWeekday = true; // never a step that can never send

  if (t.isWeekend && !allowWeekend) return { ok: false, reason: `weekend blocked (${t.day})` };
  if (!t.isWeekend && !allowWeekday) return { ok: false, reason: `weekday blocked (${t.day})` };
  if (t.mins < startHour * 60 || t.mins >= endHour * 60) {
    return { ok: false, reason: `outside ${startHour}:00–${endHour}:00 (local ${fmt(t.mins)})` };
  }
  return { ok: true };
}

/** Is "now" OK to send for this region, given a campaign window + a step's allowed days? */
export function canSendNow(region, window, days) {
  return evaluateWindow(regionNow(region), window, days);
}
