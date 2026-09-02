// api/well-known-oauth-prm.js — served at /.well-known/oauth-protected-resource (and
// /.well-known/oauth-protected-resource/mcp) via the rewrites in vercel.json. This is
// what a 401 from /api/mcp points to via its WWW-Authenticate header, so a client that
// hits /api/mcp cold can discover which authorization server to use without being told
// up front.
import { appBaseUrl } from '../lib/util.js';

export default async function handler(req, res) {
  const base = appBaseUrl();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header']
  });
}
