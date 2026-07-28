// lib/hubspot.js — all HubSpot API interactions
import { getPlaceholders } from './settings.js';
import { propsForObject } from './tokens.js';

const BASE = 'https://api.hubapi.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function hs(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: headers() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HubSpot ${options.method || 'GET'} ${path} → ${res.status}: ${err.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Contacts due for a send: dw_campaign set, dw_next_send <= now,
 * and not opted out. Paginates up to `max`.
 */
export async function getDueContacts(max = 200) {
  const now = Date.now();
  let results = [];
  let after = null;

  while (results.length < max) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'dw_campaign', operator: 'HAS_PROPERTY' },
          { propertyName: 'dw_next_send', operator: 'LTE', value: String(now) },
          { propertyName: 'hs_email_optout', operator: 'NEQ', value: 'true' }
        ]
      }],
      properties: ['email', 'firstname', 'lastname', 'dw_campaign', 'dw_campaign_step', 'dw_next_send'],
      sorts: [{ propertyName: 'dw_next_send', direction: 'ASCENDING' }],
      limit: Math.min(100, max - results.length)
    };
    if (after) body.after = after;

    const data = await hs('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    results = results.concat(data.results || []);
    if (data.paging?.next?.after && results.length < max) after = data.paging.next.after;
    else break;
  }

  return results;
}

/**
 * Resolve the DEAL owner for a contact:
 * contact → associated deals → most recently created deal → hubspot_owner_id.
 * Returns null if no deal or no owner.
 */
/**
 * The sender's deal for a contact = the most recently created deal that HAS an owner.
 * Returns { ownerId, dealName, location } in one fetch — dealName/location often carry the
 * lead's ZIP, which we use to resolve region when the contact has no zip_code of its own.
 */
export async function getOwnerAndDealName(contactId) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=50`);
  const dealIds = (assoc.results || []).map(r => r.toObjectId);
  if (dealIds.length === 0) return { dealId: null, ownerId: null, dealName: '', location: '', leadRegion: '' };

  const read = (props) => hs('/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    body: JSON.stringify({ inputs: dealIds.map(id => ({ id: String(id) })), properties: props })
  });

  const REQUIRED = ['hubspot_owner_id', 'createdate', 'dealstage', 'dealname'];
  const OPTIONAL = ['location', 'lead_region'];
  let registryProps = [];
  try { registryProps = propsForObject(await getPlaceholders(), 'deal'); } catch { /* registry optional */ }

  let batch;
  try {
    batch = await read([...REQUIRED, ...OPTIONAL, ...registryProps]);
  } catch {
    try {
      // A bad registry property shouldn't cost us location/lead_region too.
      batch = await read([...REQUIRED, ...OPTIONAL]);
    } catch {
      batch = await read(REQUIRED);
    }
  }

  const deals = (batch.results || [])
    .filter(d => d.properties?.hubspot_owner_id)
    .sort((a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate));

  const top = deals[0];
  return {
    dealId: top?.id ? String(top.id) : null,
    properties: top?.properties || {},   // raw bag, for placeholder resolution
    ownerId: top?.properties?.hubspot_owner_id || null,
    dealName: top?.properties?.dealname || '',
    location: top?.properties?.location || '',
    leadRegion: top?.properties?.lead_region || ''
  };
}

/** Owner id for a contact's sender deal (thin wrapper — used by the reply sweep). */
export async function getDealOwnerId(contactId) {
  return (await getOwnerAndDealName(contactId)).ownerId;
}

/** Owner id → { email, firstName, lastName }. Build once per run. */
export async function buildOwnerMap() {
  const map = {};
  let after = null;
  while (true) {
    let path = '/crm/v3/owners?limit=100';
    if (after) path += `&after=${after}`;
    const data = await hs(path);
    for (const o of data.results || []) {
      map[String(o.id)] = {
        email: o.email,
        firstName: o.firstName || '',
        lastName: o.lastName || ''
      };
    }
    if (data.paging?.next?.after) after = data.paging.next.after;
    else break;
  }
  return map;
}

/**
 * Contacts mid-sequence, waiting for a future step (dw_next_send > now).
 * These are the ones a reply-sweep should check.
 */
export async function getWaitingContacts(max = 100) {
  const body = {
    filterGroups: [{
      filters: [
        { propertyName: 'dw_campaign', operator: 'HAS_PROPERTY' },
        { propertyName: 'dw_next_send', operator: 'GT', value: String(Date.now()) }
      ]
    }],
    properties: ['email', 'dw_campaign', 'dw_campaign_step'],
    limit: Math.min(100, max)
  };
  const data = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
  return data.results || [];
}

/**
 * Contacts whose sequence has finished (campaign still stamped, nothing pending).
 * Reply-sweep checks these for ~14 days after their last send (window enforced by caller
 * via the recorded last-send timestamp).
 */
export async function getCompletedContacts(max = 100) {
  const body = {
    filterGroups: [{
      filters: [
        { propertyName: 'dw_campaign', operator: 'HAS_PROPERTY' },
        { propertyName: 'dw_next_send', operator: 'NOT_HAS_PROPERTY' }
      ]
    }],
    properties: ['email', 'dw_campaign', 'dw_campaign_step'],
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
    limit: Math.min(100, max)
  };
  const data = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
  return data.results || [];
}

/** Property list fetched for anyone the engine might send to (email + SMS). */
export const CONTACT_PROPS_BASE = [
  'email', 'firstname', 'lastname', 'phone', 'zip_code',
  'dw_campaign', 'dw_campaign_step', 'dw_next_send', 'hs_email_optout'
];
/** Comma string kept for existing call sites (api/hook.js). */
export const CONTACT_PROPS = CONTACT_PROPS_BASE.join(',');

/** Base props plus any contact properties the placeholder registry needs. */
export async function contactPropsList() {
  try {
    const extra = propsForObject(await getPlaceholders(), 'contact');
    return [...new Set([...CONTACT_PROPS_BASE, ...extra])];
  } catch {
    return CONTACT_PROPS_BASE;
  }
}

/** Real-time contact read (search results can be stale by up to ~1 min). */
export async function getContactLive(contactId) {
  const props = (await contactPropsList()).join(',');
  return hs(`/crm/v3/objects/contacts/${contactId}?properties=${props}`);
}

/** How many calls are logged on a contact (used by stop-if-called). 0 on any error. */
export async function getLoggedCallCount(contactId) {
  try {
    const data = await hs(`/crm/v3/objects/contacts/${contactId}/associations/calls`);
    return (data.results || []).length;
  } catch {
    return 0;
  }
}


/** Newest associated deal for a contact, with the given properties. Null if none. */
export async function getPrimaryDeal(contactId, properties) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=50`);
  const dealIds = (assoc.results || []).map(r => r.toObjectId);
  if (dealIds.length === 0) return null;
  const batch = await hs('/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    body: JSON.stringify({
      inputs: dealIds.map(id => ({ id: String(id) })),
      properties: [...new Set(['createdate', ...properties])]
    })
  });
  const deals = (batch.results || []).sort((a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate));
  return deals[0] || null;
}

/** Create a task assigned to an owner, associated to a deal. Returns task id. */
export async function createTask({ dealId, ownerId, subject, body, dueInDays = 0 }) {
  const res = await hs('/crm/v3/objects/tasks', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_task_subject: subject,
        hs_task_body: body,
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'HIGH',
        hs_timestamp: new Date(Date.now() + dueInDays * 86400000).toISOString(),
        ...(ownerId ? { hubspot_owner_id: ownerId } : {})
      },
      associations: dealId ? [{
        to: { id: String(dealId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }]
      }] : []
    })
  });
  return res?.id;
}

/** Update contact properties. */
export async function updateContact(contactId, properties) {
  return hs(`/crm/v3/objects/contacts/${contactId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties })
  });
}

/** PATCH a deal's properties. `lead_region` lives here, not on the contact. */
export async function updateDeal(dealId, properties) {
  return hs(`/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties })
  });
}

/**
 * Log the send to the contact's timeline as an email engagement,
 * so it appears on the record like any sales email.
 * Association typeId 198 = email → contact.
 */
export async function logEmailToTimeline({ contactId, ownerId, subject, body, campaign, step }) {
  return hs('/crm/v3/objects/emails', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hubspot_owner_id: ownerId,
        hs_email_direction: 'EMAIL',
        hs_email_status: 'SENT',
        hs_email_subject: subject,
        hs_email_text: body,
        hs_email_headers: JSON.stringify({ from: { email: 'via dogwise-mailer' } })
      },
      associations: [{
        to: { id: String(contactId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 198 }]
      }]
    })
  });
}

// ── Tasks ──────────────────────────────────────────────────────────────────
// Association type IDs are portal-independent for HUBSPOT_DEFINED labels, but rather
// than hardcode a number that could be wrong, look it up once and cache it. Falls back
// to HubSpot's documented defaults if the lookup endpoint is unavailable.
const FALLBACK_ASSOC = { 'tasks:deals': 216, 'tasks:contacts': 204 };
const assocCache = new Map();

export async function associationTypeId(from, to) {
  const key = `${from}:${to}`;
  if (assocCache.has(key)) return assocCache.get(key);
  let id = FALLBACK_ASSOC[key] ?? null;
  try {
    const r = await hs(`/crm/v4/associations/${from}/${to}/labels`);
    const hit = (r.results || []).find(x => x.category === 'HUBSPOT_DEFINED');
    if (hit?.typeId) id = hit.typeId;
  } catch { /* keep the fallback */ }
  assocCache.set(key, id);
  return id;
}

/**
 * Create a task on a deal, assigned to an owner.
 * @param {object} o
 * @param {string} o.dealId
 * @param {string} o.ownerId
 * @param {string} o.subject
 * @param {string} [o.body]        notes shown on the task
 * @param {number} [o.dueInDays=1]
 * @param {string} [o.priority]    LOW | MEDIUM | HIGH
 */
export async function createDealTask({ dealId, ownerId, subject, body = '', dueInDays = 1, priority = 'MEDIUM' }) {
  if (!dealId) throw new Error('createDealTask needs a dealId');
  const typeId = await associationTypeId('tasks', 'deals');

  const properties = {
    hs_task_subject: String(subject || 'Follow up').slice(0, 255),
    hs_task_body: String(body || ''),
    hs_task_status: 'NOT_STARTED',
    hs_task_type: 'TODO',
    hs_task_priority: priority,
    hs_timestamp: String(Date.now() + Math.max(0, dueInDays) * 86400000)
  };
  if (ownerId) properties.hubspot_owner_id = String(ownerId);

  const payload = { properties };
  if (typeId) {
    payload.associations = [{
      to: { id: String(dealId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }]
    }];
  }

  return hs('/crm/v3/objects/tasks', { method: 'POST', body: JSON.stringify(payload) });
}
