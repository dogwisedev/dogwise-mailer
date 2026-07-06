// api/settings.js — dashboard settings API (sender booking links)
import { getSettings, saveSettings } from '../lib/settings.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method === 'GET') return res.status(200).json(await getSettings());
  if (req.method === 'POST') {
    const { senderLinks = {}, senderLinkFallback = '' } = req.body || {};
    const clean = {};
    for (const [email, url] of Object.entries(senderLinks)) {
      if (email.trim() && String(url).trim()) clean[email.trim().toLowerCase()] = String(url).trim();
    }
    return res.status(200).json(await saveSettings({ senderLinks: clean, senderLinkFallback: String(senderLinkFallback).trim() }));
  }
  return res.status(405).json({ error: 'method not allowed' });
}
