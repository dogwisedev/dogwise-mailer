// api/settings.js — dashboard settings API: booking links + the SMS number map.
// POST MERGES with existing settings, so the booking-links screen and the SMS-numbers
// screen can each save independently without clobbering the other. All phone-number
// ids are trimmed on the way in (so a stray trailing space can never reach OpenPhone).
import { getSettings, saveSettings } from '../lib/settings.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method === 'GET') return res.status(200).json(await getSettings());

  if (req.method === 'POST') {
    const current = await getSettings();
    const body = req.body || {};
    const next = { ...current };

    if (body.senderLinks !== undefined) {
      const clean = {};
      for (const [email, url] of Object.entries(body.senderLinks || {})) {
        if (email.trim() && String(url).trim()) clean[email.trim().toLowerCase()] = String(url).trim();
      }
      next.senderLinks = clean;
    }

    if (body.senderLinkFallback !== undefined) {
      next.senderLinkFallback = String(body.senderLinkFallback).trim();
    }

    if (body.smsNumbers !== undefined) {
      const clean = {};
      for (const [ownerId, byRegion] of Object.entries(body.smsNumbers || {})) {
        const inner = {};
        for (const [region, pn] of Object.entries(byRegion || {})) {
          if (String(pn).trim()) inner[region] = String(pn).trim();
        }
        if (Object.keys(inner).length) clean[String(ownerId)] = inner;
      }
      next.smsNumbers = clean;
    }

    return res.status(200).json(await saveSettings(next));
  }

  return res.status(405).json({ error: 'method not allowed' });
}
