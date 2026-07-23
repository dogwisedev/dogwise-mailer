// api/owners.js — HubSpot owners for the "person" dropdown on the SMS numbers screen.
import { buildOwnerMap } from '../lib/hubspot.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const map = await buildOwnerMap();
    const owners = Object.entries(map).map(([id, o]) => ({
      id,
      email: o.email || '',
      name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || id
    })).sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ owners });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
