// api/hook.js — HubSpot "Send a webhook" workflow action hits this for INSTANT sends.
// Configure in HubSpot (place AFTER the Edit-record actions that set dw_* properties):
//   Target URL: https://<your-app>.vercel.app/api/hook?secret=<CRON_SECRET>
//   Method: POST  |  Retry on failure: ✓
// Works with deal-based workflows (looks up associated contacts) or contact-based ones.
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap } from '../lib/hubspot.js';
import { processContact } from '../lib/process.js';

const BASE = 'https://api.hubapi.com';
const CONTACT_PROPS = 'email,firstname,lastname,dw_campaign,dw_campaign_step,dw_next_send,hs_email_optout';

async function hs(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` } });
  if (!res.ok) throw new Error(`HubSpot GET ${path} → ${res.status}`);
  return res.json();
}

function extractIds(payload) {
  // HubSpot workflow webhooks vary by version. Hunt for the record id across known shapes.
  const p = payload || {};
  const cand =
    p.objectId ?? p.hs_object_id ?? p.vid ?? p.dealId ?? p.contactId ??
    p.object?.objectId ?? p.primaryObjectId ??
    p.properties?.hs_object_id?.value ?? p.properties?.hs_object_id ??
    (Array.isArray(p) && p[0]?.objectId) ?? null;

  const typeHint = String(p.objectTypeId || p.objectType || p.subscriptionType || '').toLowerCase();
  const objectType = typeHint.includes('0-1') || typeHint.includes('contact') || p.vid ? 'contact'
    : typeHint.includes('0-3') || typeHint.includes('deal') || p.dealId ? 'deal'
    : null;

  return { objectId: cand != null ? String(cand) : null, objectType };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (process.env.CRON_SECRET && req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { objectId, objectType } = extractIds(req.body || {});
  if (!objectId) return res.status(200).json({ ok: false, reason: 'no object id in payload', receivedSample: JSON.stringify(req.body || {}).slice(0, 800) });

  try {
    // Resolve to contact IDs
    let contactIds = [];
    if (objectType === 'deal' || !objectType) {
      // Assume deal first (your enroller is deal-based); fall back to treating it as a contact
      try {
        const assoc = await hs(`/crm/v4/objects/deals/${objectId}/associations/contacts?limit=20`);
        contactIds = (assoc.results || []).map(r => String(r.toObjectId));
      } catch { /* not a deal */ }
    }
    if (contactIds.length === 0) contactIds = [objectId];

    const [campaigns, ownerMap] = await Promise.all([getCampaigns(), buildOwnerMap()]);
    const results = [];

    for (const id of contactIds) {
      try {
        const contact = await hs(`/crm/v3/objects/contacts/${id}?properties=${CONTACT_PROPS}`);
        // Only send if actually due now (dw_next_send <= now) — respects future-dated steps
        const next = parseInt(contact.properties?.dw_next_send || '', 10);
        if (!contact.properties?.dw_campaign || isNaN(next) || next > Date.now()) {
          results.push({ id, status: 'skipped', detail: 'not due' });
          continue;
        }
        results.push({ id, ...(await processContact(contact, campaigns, ownerMap)) });
      } catch (err) {
        results.push({ id, status: 'error', detail: err.message });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
