// api/oauth/token.js — the token endpoint. Handles both grant types:
//   authorization_code — first login, exchanges the one-time code from /authorize
//   refresh_token       — later token renewals, once the access token expires
import crypto from 'node:crypto';
import { consumeAuthCode, pkceMatches, issueTokens, rotateRefreshToken } from '../../lib/oauth.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Client auth per RFC 6749 §2.3: client_secret_post (body params) or client_secret_basic (Authorization header). */
function clientCreds(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Basic ')) {
    try {
      const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      return { id, secret };
    } catch { /* fall through to body */ }
  }
  const b = req.body || {};
  return { id: b.client_id, secret: b.client_secret };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'invalid_request', error_description: 'POST only' });
  if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET) {
    return res.status(500).json({ error: 'server_error', error_description: 'OAuth is not configured' });
  }

  const { id, secret } = clientCreds(req);
  if (!safeEqual(id, process.env.OAUTH_CLIENT_ID) || !safeEqual(secret, process.env.OAUTH_CLIENT_SECRET)) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  const body = req.body || {};

  try {
    if (body.grant_type === 'authorization_code') {
      const record = await consumeAuthCode(body.code);
      if (!record) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code unknown, expired, or already used.' });
      if (record.redirectUri !== body.redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match the one used at /authorize.' });
      }
      if (!pkceMatches(body.code_verifier, record.codeChallenge, record.codeChallengeMethod)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE code_verifier does not match.' });
      }
      const { accessToken, refreshToken, expiresIn } = await issueTokens();
      return res.status(200).json({
        access_token: accessToken, refresh_token: refreshToken,
        token_type: 'Bearer', expires_in: expiresIn, scope: 'sequences'
      });
    }

    if (body.grant_type === 'refresh_token') {
      const fresh = await rotateRefreshToken(body.refresh_token);
      if (!fresh) return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token unknown or expired.' });
      return res.status(200).json({
        access_token: fresh.accessToken, refresh_token: fresh.refreshToken,
        token_type: 'Bearer', expires_in: fresh.expiresIn, scope: 'sequences'
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', error_description: e.message });
  }
}
