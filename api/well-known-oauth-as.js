// api/well-known-oauth-as.js — served at /.well-known/oauth-authorization-server via
// the rewrite in vercel.json. Tells an MCP client (Claude) where to send someone to log
// in and where to trade a code for a token. See lib/oauth.js for what's actually behind
// these URLs, and why this is a single-client, single-login server rather than a
// general one.
import { appBaseUrl } from '../lib/util.js';

export default async function handler(req, res) {
  const base = appBaseUrl();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['sequences']
  });
}
