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

function toE164(phone) {
  return `+1${String(phone).replace(/\D/g, '').slice(-10)}`;
}

/**
 * Send a text. `from` is an OpenPhone phone-number id (PN…). `to` is any phone string.
 * Returns { ok, id? , error? }.
 */
export async function sendSms({ from, to, content }) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ from: String(from).trim(), to: [toE164(to)], content })
  });
  if (!res.ok) return { ok: false, error: `OpenPhone ${res.status}: ${(await res.text()).slice(0, 200)}` };
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
    const qs = new URLSearchParams({ phoneNumberId: String(phoneNumberId).trim(), maxResults: '25' });
    qs.append('participants[]', toE164(contactPhone));
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
