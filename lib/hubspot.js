// lib/hubspot.js — all HubSpot API interactions
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
export async function getDealOwnerId(contactId) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=50`);
  const dealIds = (assoc.results || []).map(r => r.toObjectId);
  if (dealIds.length === 0) return null;

  const batch = await hs('/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    body: JSON.stringify({
      inputs: dealIds.map(id => ({ id: String(id) })),
      properties: ['hubspot_owner_id', 'createdate', 'dealstage']
    })
  });

  const deals = (batch.results || [])
    .filter(d => d.properties?.hubspot_owner_id)
    .sort((a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate));

  return deals[0]?.properties?.hubspot_owner_id || null;
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

/** Real-time contact read (search results can be stale by up to ~1 min). */
export async function getContactLive(contactId) {
  const props = 'email,firstname,lastname,dw_campaign,dw_campaign_step,dw_next_send,hs_email_optout';
  return hs(`/crm/v3/objects/contacts/${contactId}?properties=${props}`);
}

/** Update contact properties. */
export async function updateContact(contactId, properties) {
  return hs(`/crm/v3/objects/contacts/${contactId}`, {
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
