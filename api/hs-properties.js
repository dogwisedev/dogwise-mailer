// api/hs-properties.js — feeds the placeholder editor's property picker.
//
// Why this exists: HubSpot SILENTLY IGNORES unknown property names on object reads.
// A typo'd or wrong-object property therefore produces an empty token instead of an
// error — the exact failure mode that hid `lead_region` (a deal property being written
// to a contact) for a full day. Picking from a real list makes that impossible.
//
//   GET /api/hs-properties?object=deal              → selectable properties
//   GET /api/hs-properties?object=deal&name=amount  → { exists: true, ... }

const BASE = 'https://api.hubapi.com';

const OBJECT_PATH = { contact: 'contacts', deal: 'deals', email: 'emails' };

// Types we can render sensibly in an email. Excludes files, calculated rollups, etc.
const USABLE_TYPES = new Set(['string', 'number', 'date', 'datetime', 'enumeration', 'bool']);

/** Suggest a display format so {{value}} doesn't render "4500" or an epoch. */
function suggestFormat(p) {
  if (p.type === 'date' || p.type === 'datetime') return 'date';
  if (p.name === 'amount' || /amount|price|balance|cost|fee|deposit/i.test(p.name)) return 'currency';
  if (p.type === 'number') return 'number';
  return 'raw';
}

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const object = String(req.query.object || '').toLowerCase();

  // The owner object isn't a CRM object — its fields are fixed.
  if (object === 'owner') {
    return res.status(200).json({
      object,
      properties: [
        { name: 'firstname', label: 'Owner first name', type: 'string', format: 'raw' },
        { name: 'lastname', label: 'Owner last name', type: 'string', format: 'raw' },
        { name: 'fullname', label: 'Owner full name', type: 'string', format: 'raw' },
        { name: 'email', label: 'Owner email', type: 'string', format: 'raw' }
      ]
    });
  }

  const path = OBJECT_PATH[object];
  if (!path) return res.status(400).json({ error: 'object must be contact, deal or owner' });

  try {
    const r = await fetch(`${BASE}/crm/v3/properties/${path}?archived=false`, {
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` }
    });
    if (!r.ok) {
      return res.status(502).json({ error: `HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}` });
    }
    const data = await r.json();
    const all = data.results || [];

    // Single-property existence check, used when saving a registry row.
    const name = String(req.query.name || '').trim();
    if (name) {
      const hit = all.find(p => p.name === name);
      if (!hit) {
        return res.status(200).json({
          exists: false,
          error: `"${name}" is not a ${object} property. Check whether it lives on the other object.`
        });
      }
      return res.status(200).json({
        exists: true,
        name: hit.name,
        label: hit.label,
        type: hit.type,
        fieldType: hit.fieldType,
        format: suggestFormat(hit),
        options: (hit.options || []).map(o => ({ value: o.value, label: o.label }))
      });
    }

    const properties = all
      .filter(p => (USABLE_TYPES.has(p.type) || p.name === 'hs_email_html') && !p.hidden)
      .map(p => ({
        name: p.name,
        label: p.label || p.name,
        type: p.type,
        group: p.groupName || '',
        format: suggestFormat(p)
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return res.status(200).json({ object, count: properties.length, properties });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
