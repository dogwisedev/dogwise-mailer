// lib/tokens.js — SINGLE source of truth for {{token}} resolution.
//
// Replaces the duplicated TOKEN_RE / defaultFor that used to live in both util.js and
// marketing.js. Two kinds of token are supported:
//
//   BUILT-IN   {{firstname}}, {{sender_booking_link}}, {{deal.amount_outstanding}}
//              Flat or dotted. Supplied by process.js / checklist.js in `vars`.
//
//   REGISTRY   {{dog_name}}  — user-defined in Settings, mapped to a HubSpot property
//              on the contact, deal or owner, with a per-token fallback.
//
// NOTE the character class: [a-z0-9_.] — it must allow DIGITS (HubSpot names like
// `k9___dog_name`) and DOTS (`deal.amount_outstanding`). The old class was [a-z_]
// which silently shipped those tokens to customers as literal braces.

export const TOKEN_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

/** Tokens a user may NOT redefine in the registry — process.js owns these. */
export const RESERVED_TOKENS = new Set([
  'firstname', 'lastname', 'email', 'phone',
  'sender_firstname', 'sender_lastname', 'sender_fullname', 'sender_booking_link',
  'days_left'
]);

export const PLACEHOLDER_OBJECTS = ['contact', 'deal', 'owner'];
export const PLACEHOLDER_FORMATS = ['raw', 'currency', 'date', 'number'];

/** Last-resort defaults so a missing value never reads as a hole in a sentence. */
const BUILTIN_FALLBACK = { firstname: 'there' };

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render a raw HubSpot value for humans.
 *   currency  4500          -> $4,500.00
 *   date      1755400000000 -> Monday, August 17   (also accepts ISO strings)
 *   number    4500          -> 4,500
 */
export function formatValue(v, format) {
  if (v == null || v === '') return '';
  switch (format) {
    case 'currency': {
      const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n)
        ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
        : String(v);
    }
    case 'date': {
      const raw = String(v).trim();
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      return Number.isFinite(ms)
        ? new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        : String(v);
    }
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString('en-US') : String(v);
    }
    default:
      return String(v);
  }
}

/** vars → fallbacks → built-in default → ''. */
function lookup(key, vars = {}, fallbacks = {}) {
  const k = String(key).toLowerCase();
  const v = vars[k];
  if (v != null && v !== '') return String(v);
  const f = fallbacks[k];
  if (f != null && f !== '') return String(f);
  return BUILTIN_FALLBACK[k] ?? '';
}

/** Plain-text substitution (subjects, SMS bodies, text/plain parts). */
export function personalize(template, vars, fallbacks) {
  return String(template ?? '').replace(TOKEN_RE, (_, key) => lookup(key, vars, fallbacks));
}

/** Same grammar, HTML-escaped — for anything landing inside markup. */
export function personalizeHtml(html, vars, fallbacks) {
  return String(html ?? '').replace(TOKEN_RE, (_, key) => escHtml(lookup(key, vars, fallbacks)));
}

/** Alias kept so existing marketing.js call sites read naturally. */
export const personalizeText = personalize;

// ── Registry ────────────────────────────────────────────────────────────────
// Shape: { token, object: 'contact'|'deal'|'owner', property, fallback, format }

/** Clean + validate a registry list. Returns { placeholders, errors }. */
export function normalizePlaceholders(list) {
  const out = [];
  const errors = [];
  const seen = new Set();

  for (const [i, row] of (Array.isArray(list) ? list : []).entries()) {
    const label = `Row ${i + 1}`;
    const token = String(row?.token ?? '').trim().toLowerCase();
    const object = String(row?.object ?? '').trim().toLowerCase();
    const property = String(row?.property ?? '').trim();

    if (!token) { errors.push(`${label}: needs a token name`); continue; }
    if (!/^[a-z][a-z0-9_]*$/.test(token)) {
      errors.push(`${label}: "${token}" — use lowercase letters, numbers and underscores, starting with a letter`);
      continue;
    }
    if (RESERVED_TOKENS.has(token)) { errors.push(`${label}: "${token}" is a built-in token — pick another name`); continue; }
    if (seen.has(token)) { errors.push(`${label}: "${token}" is defined twice`); continue; }
    if (!PLACEHOLDER_OBJECTS.includes(object)) { errors.push(`${label}: object must be contact, deal or owner`); continue; }
    if (!property) { errors.push(`${label}: needs a HubSpot property name`); continue; }
    if (object !== 'owner' && !/^[a-z0-9_]+$/.test(property)) {
      errors.push(`${label}: "${property}" isn't a valid HubSpot internal name`);
      continue;
    }

    const format = PLACEHOLDER_FORMATS.includes(row?.format) ? row.format : 'raw';
    seen.add(token);
    out.push({ token, object, property, fallback: String(row?.fallback ?? ''), format });
  }

  return { placeholders: out, errors };
}

/** Property names the registry needs fetched for one object type. */
export function propsForObject(placeholders, object) {
  return [...new Set(
    (placeholders || [])
      .filter(p => p.object === object && p.property)
      .map(p => p.property)
  )];
}

/**
 * Resolve every registry token against already-fetched records.
 * @param {Array}  placeholders
 * @param {object} sources { contact: {...props}, deal: {...props}, owner: {...} }
 * @returns {object} token -> display-ready string (fallback already applied)
 */
export function registryVars(placeholders, sources = {}) {
  const vars = {};
  for (const p of placeholders || []) {
    const bag = sources[p.object] || {};
    const formatted = formatValue(bag[p.property], p.format);
    // Fallback applied here, so every existing personalize() call site works unchanged.
    vars[p.token] = formatted !== '' ? formatted : (p.fallback || '');
  }
  return vars;
}

/** Every token name currently usable, for the editor dropdown. */
export function tokenCatalogue(placeholders) {
  const builtins = [
    { token: 'firstname', label: "Contact first name", group: 'Built-in' },
    { token: 'lastname', label: 'Contact last name', group: 'Built-in' },
    { token: 'email', label: 'Contact email', group: 'Built-in' },
    { token: 'sender_firstname', label: 'Sender first name', group: 'Built-in' },
    { token: 'sender_lastname', label: 'Sender last name', group: 'Built-in' },
    { token: 'sender_fullname', label: 'Sender full name', group: 'Built-in' },
    { token: 'sender_booking_link', label: "Sender's booking link", group: 'Built-in' }
  ];
  const custom = (placeholders || []).map(p => ({
    token: p.token,
    label: `${p.object}.${p.property}`,
    group: 'Your placeholders'
  }));
  return [...builtins, ...custom];
}
