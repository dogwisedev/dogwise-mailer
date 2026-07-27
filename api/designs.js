// api/designs.js — marketing design store. Same auth shape as api/campaigns.js.
//
//   GET    /api/designs            → { designs: [{id,name,updatedAt}], storeConfigured }
//   GET    /api/designs?id=xyz     → { design: {id,name,design,html,text,updatedAt} }
//   POST   /api/designs            → body { id, name, design, html, text }
//   DELETE /api/designs            → body { id, force? }
//
// The builder page authenticates with the same ADMIN_PASSWORD the dashboard already uses.
import { listDesigns, getDesign, saveDesign, deleteDesign, designUsage, designsConfigured } from '../lib/designs.js';
import { getCampaigns } from '../lib/store.js';
import { checkBody } from '../lib/spamcheck.js';

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth === `Bearer ${process.env.ADMIN_PASSWORD}`;
  // The builder is a separate static page opened in a new tab; allow ?secret= like test-send does.
  const query = req.query?.secret && req.query.secret === process.env.ADMIN_PASSWORD;
  return Boolean(process.env.ADMIN_PASSWORD) && (bearer || query);
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong password' });

  try {
    if (req.method === 'GET') {
      const id = req.query?.id;
      if (id) {
        const design = await getDesign(id);
        if (!design) return res.status(404).json({ error: 'Design not found' });
        return res.status(200).json({ design });
      }
      return res.status(200).json({ designs: await listDesigns(), storeConfigured: designsConfigured() });
    }

    if (req.method === 'POST') {
      const { id, name, design, html, text } = req.body || {};
      // Advisory only — a low score never blocks a save. The builder shows the findings.
      const preflight = checkBody({
        html, text,
        footerAdded: true,
        ownDomain: process.env.BRAND_DOMAIN || 'dogwiseacademy.com'
      });
      const saved = await saveDesign({ id, name, design, html, text, score: preflight.score });
      // Don't echo the full document back — the builder already has it.
      return res.status(200).json({
        ok: true, id: saved.id, name: saved.name, updatedAt: saved.updatedAt,
        score: preflight.score, findings: preflight.findings
      });
    }

    if (req.method === 'DELETE') {
      const { id, force } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!force) {
        const uses = designUsage(await getCampaigns(), id);
        if (uses.length) {
          return res.status(409).json({
            error: 'This design is still used by a live sequence',
            uses
          });
        }
      }
      await deleteDesign(id);
      return res.status(200).json({ ok: true, designs: await listDesigns() });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Design save failed' });
  }
}
