// api/oauth/authorize.js — GET shows a login page; POST (the form submit) checks the
// password and, if correct, issues a single-use authorization code and redirects back
// to whatever redirect_uri the client (Claude) supplied.
//
// SECURITY NOTES
// - redirect_uri is checked against an allowlist of HOSTS (OAUTH_ALLOWED_REDIRECT_HOSTS,
//   default "claude.ai,claude.com") — not a fixed exact URL, because Claude's own
//   callback path isn't something we control or want to hardcode. This is intentionally
//   narrower than "accept any redirect_uri", which would turn this endpoint into an open
//   redirector usable for phishing.
// - The login password (OAUTH_LOGIN_PASSWORD) is checked with a constant-time compare.
// - state is passed through untouched, exactly as the client sent it — we never
//   generate or interpret it ourselves.
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
  
  // Cold, unsettling error message
  const sinisterError = error ? 'Credentials rejected. The machine waits.' : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Too Late To Go Back Now</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#fdfdfd;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#111;}
  .card{background:#fff;border:1px solid #d1d1d1;padding:40px;width:100%;max-width:340px;box-shadow:0 10px 30px rgba(0,0,0,.03)}
  h1{font-size:16px;margin:0 0 16px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;}
  p{font-size:13px;color:#555;margin:0 0 32px;line-height:1.6;}
  label{display:block;font-size:11px;font-weight:600;color:#777;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px}
  input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccc;font-size:14px;margin-bottom:24px;font-family:inherit;background:#fafafa;transition:all 0.2s; border-radius:0;}
  input[type=password]:focus{outline:none;border-color:#111;background:#fff}
  button{width:100%;padding:14px;border:1px solid #111;background:#111;color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all 0.2s;text-transform:uppercase;letter-spacing:1px; border-radius:0;}
  button:hover{background:#fff;color:#111;}
  .err{color:#000;border-left:2px solid #000;padding:8px 12px;font-size:12px;margin-bottom:24px;background:#f5f5f5;}
</style></head><body>
<div class="card">
  <h1>Welcome to the Thunderdome</h1>
  <p>If everything seems under control, you're not going fast enough.</p>
  ${error ? `<div class="err">${escAttr(sinisterError)}</div>` : ''}
  <form method="POST">
    ${hidden}
    <label for="pw">Authorization Key</label>
    <input type="password" name="password" id="pw" autofocus required autocomplete="off">
    <button type="submit">Lets Go Baby</button>
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
