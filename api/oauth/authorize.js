// api/oauth/authorize.js — GET shows a login page; POST (the form submit) checks the
// password and, if correct, issues a single-use authorization code and redirects back
// to whatever redirect_uri the client (Claude) supplied.
//
// SECURITY NOTES
// - redirect_uri is checked against an allowlist of HOSTS (OAUTH_ALLOWED_REDIRECT_HOSTS,
//   default "claude.ai,claude.com") — not a fixed exact URL, because Claude's own
//   callback path isn't something we control or want to hardcode. This is intentionally
//   narrower than "accept any redirect_uri", which would turn this endpoint into an open
//   redirector usable for phishing.
// - The login password (OAUTH_LOGIN_PASSWORD) is checked with a constant-time compare.
// - state is passed through untouched, exactly as the client sent it — we never
//   generate or interpret it ourselves.
import crypto from 'node:crypto';
import { appBaseUrl } from '../../lib/util.js';
import { createAuthCode } from '../../lib/oauth.js';

function allowedHosts() {
  return (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function redirectUriOk(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'https:') return false;
    return allowedHosts().some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function loginPage({ params, error }) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${escAttr(v)}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in — Dogwise Mailer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:-apple-system,Arial,sans-serif;background:#F6F3EC;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1.5px solid #E3E9F0;border-radius:14px;padding:32px 28px;width:100%;max-width:360px;box-shadow:0 4px 20px rgba(20,30,45,.08)}
  h1{font-size:17px;margin:0 0 6px}
  p{font-size:13px;color:#5B6B7F;margin:0 0 20px;line-height:1.5}
  label{display:block;font-size:12px;font-weight:600;color:#5B6B7F;margin-bottom:6px}
  input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #E3E9F0;border-radius:8px;font-size:14px;margin-bottom:14px}
  button{width:100%;padding:11px;border:none;border-radius:8px;background:#1B4F8A;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
  .err{background:#fdeceb;color:#b3261e;border-radius:8px;padding:8px 12px;font-size:12.5px;margin-bottom:14px}
</style></head><body>
<div class="card">
  <h1>Connect Claude to Dogwise Mailer</h1>
  <p>Sign in to let Claude create and manage sequences, and read your campaign analytics.</p>
  ${error ? `<div class="err">${escAttr(error)}</div>` : ''}
  <form method="POST">
    ${hidden}
    <label for="pw">Password</label>
    <input type="password" name="password" id="pw" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

export default async function handler(req, res) {
  if (!process.env.OAUTH_LOGIN_PASSWORD) {
    return res.status(500).send('OAuth is not configured yet — set OAUTH_LOGIN_PASSWORD, OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.');
  }

  const q = req.method === 'GET' ? req.query : (req.body || {});
  const {
    response_type, client_id, redirect_uri, state,
    code_challenge, code_challenge_method
  } = q;

  const params = { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method };

  if (response_type !== 'code') return res.status(400).send('Only response_type=code is supported.');
  if (client_id !== process.env.OAUTH_CLIENT_ID) return res.status(400).send('Unknown client_id.');
  if (!redirect_uri || !redirectUriOk(redirect_uri)) return res.status(400).send('redirect_uri missing or not on an allowed host.');
  if (code_challenge && code_challenge_method && code_challenge_method !== 'S256') {
    return res.status(400).send('Only the S256 PKCE method is supported.');
  }

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(loginPage({ params }));
  }

  if (req.method === 'POST') {
    if (!safeEqual(q.password, process.env.OAUTH_LOGIN_PASSWORD)) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(401).send(loginPage({ params, error: 'Wrong password — try again.' }));
    }

    const code = await createAuthCode({
      redirectUri: redirect_uri, codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method, clientId: client_id
    });

    const dest = new URL(redirect_uri);
    dest.searchParams.set('code', code);
    if (state != null) dest.searchParams.set('state', state);
    res.setHeader('Location', dest.toString());
    return res.status(302).end();
  }

  return res.status(405).send('Method not allowed');
}
