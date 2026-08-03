// lib/sms.js — OpenPhone: send a text, list the account's numbers (for the settings
// dropdown), and check whether a lead has texted back (to stop a sequence, like an
// email reply does). "Quo" is just the internal name for this — it's OpenPhone's API.

const BASE = 'https://api.openphone.com/v1';
const KEY = () => (process.env.OPENPHONE_API_KEY || '').trim();

export function smsConfigured() {
  return Boolean(KEY());
}

function headers() {
  // OpenPhone expects the RAW api key in Authorization (no "Bearer " prefix).
  return { Authorization: KEY(), 'Content-Type': 'application/json' };
}

/**
 * Normalise to E.164, but ONLY for North American numbers. Returns null for anything else.
 *
 * The previous version was `+1${digits.slice(-10)}`, which assumed every number on earth
 * was American and silently truncated the rest. A UK mobile like +44 7700 900123 came out
 * as +17700900123 — a perfectly valid US number belonging to a stranger, who would then
 * receive our sales copy. Returning null instead means the send is refused and the step is
 * skipped, which is the only safe outcome when every OpenPhone line is US.
 */
export function toE164(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  const writtenInternational = raw.startsWith('+');

  let national = null;
  if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else if (digits.length === 10 && !writtenInternational) national = digits;
  else return null;                       // wrong length, or a + with a non-1 country code

  // NANP: area code and exchange both start 2-9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

/**
 * Send a text. `from` is an OpenPhone phone-number id (PN…). `to` is any phone string.
 * Returns { ok, id? , error? }.
 */
export async function sendSms({ from, to, content }) {
  const dest = toE164(to);
  if (!dest) {
    // 400 so lib/process.js classifies this as bad contact data and skips the step,
    // rather than retrying a number it can never reach.
    return { ok: false, status: 400,
      error: `Not a US or Canadian number: ${String(to).slice(0, 24)} — OpenPhone lines here can't reach it` };
  }
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ from: String(from).trim(), to: [dest], content })
  });
  if (!res.ok) return { ok: false, status: res.status, error: `OpenPhone ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json().catch(() => ({}));
  return { ok: true, id: data?.data?.id || data?.id || null };
}

/**
 * List the account's OpenPhone numbers for the settings dropdown → [{ id, number, name }].
 * Empty array if the key is missing or the call fails.
 * NOTE: verify this path/shape against your OpenPhone plan — I couldn't reach the API from here.
 */
export async function listNumbers() {
  if (!smsConfigured()) return [];
  try {
    const res = await fetch(`${BASE}/phone-numbers`, { headers: headers() });
    if (!res.ok) return [];
    const data = await res.json();
    const arr = data?.data || data?.phoneNumbers || [];
    return arr.map(n => ({
      id: n.id,
      number: n.number || n.phoneNumber || '',
      name: n.name || n.users?.[0]?.firstName || ''
    })).filter(n => n.id);
  } catch {
    return [];
  }
}

/**
 * Has the contact texted `phoneNumberId` back since `sinceMs`?
 * Best-effort: true / false, or null when it can't check (caller proceeds on null).
 * NOTE: verify the messages query against your OpenPhone plan.
 */
export async function hasInboundSince({ phoneNumberId, contactPhone, sinceMs }) {
  if (!smsConfigured()) return null;
  try {
    const dest = toE164(contactPhone);
    if (!dest) return null;               // unreachable number: can't verify, don't guess
    const qs = new URLSearchParams({ phoneNumberId: String(phoneNumberId).trim(), maxResults: '25' });
    qs.append('participants[]', dest);
    const res = await fetch(`${BASE}/messages?${qs.toString()}`, { headers: headers() });
    if (!res.ok) return null;
    const data = await res.json();
    const msgs = data?.data || data?.messages || [];
    return msgs.some(m => {
      const dir = String(m.direction || '').toLowerCase();
      const inbound = dir === 'incoming' || dir === 'inbound';
      const ts = new Date(m.createdAt || m.created_at || 0).getTime();
      return inbound && ts >= sinceMs;
    });
  } catch {
    return null;
  }
}
