// api/folders.js — GET the folder list / POST the whole ordered list. Create, rename,
// reorder and delete are all just "save a new list". A campaign belongs to a folder via
// its own `folder` field (the folder id), saved through /api/campaigns — so the UI can
// treat a campaign whose folder id no longer exists as simply unfiled.
import { getFolders, saveFolders } from '../lib/store.js';

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  return Boolean(process.env.ADMIN_PASSWORD) && auth === `Bearer ${process.env.ADMIN_PASSWORD}`;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    return res.status(200).json({ folders: await getFolders() });
  }

  if (req.method === 'POST') {
    const { folders } = req.body || {};
    if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders array required' });
    if (folders.length > 100) return res.status(400).json({ error: 'too many folders (max 100)' });
    return res.status(200).json({ ok: true, folders: await saveFolders(folders) });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
