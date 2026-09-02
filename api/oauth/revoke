// api/oauth/revoke.js — RFC 7009 token revocation. Lets you kill Claude's access
// immediately (e.g. from a shell: curl -u $OAUTH_CLIENT_ID:$OAUTH_CLIENT_SECRET
// -d token=<the token> https://.../api/oauth/revoke) without waiting for it to expire.
import crypto from 'node:crypto';
import { revokeToken } from '../../lib/oauth.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'invalid_request' });

  const auth = req.headers['authorization'] || '';
  let id, secret;
  if (auth.startsWith('Basic ')) {
    [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  } else {
    id = req.body?.client_id; secret = req.body?.client_secret;
  }
  if (!safeEqual(id, process.env.OAUTH_CLIENT_ID) || !safeEqual(secret, process.env.OAUTH_CLIENT_SECRET)) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
  await revokeToken(token);
  return res.status(200).json({ ok: true });
}
