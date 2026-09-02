// lib/oauth.js — minimal OAuth 2.1 authorization-code-with-PKCE storage, for letting
// Claude (or any other MCP client) log in to /api/mcp on your behalf.
//
// Deliberately NOT a general-purpose multi-tenant OAuth server: there is exactly one
// login (whoever knows OAUTH_LOGIN_PASSWORD) and exactly one pre-registered client
// (whoever holds OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET — the values you paste into
// Claude's "Advanced settings" when adding the custom connector). No dynamic client
// registration, no per-user accounts. That keeps this small enough to actually reason
// about, which matters more than generality for a single-team internal tool.
//
// Everything short-lived (auth codes) or revocable (tokens) lives in Upstash Redis,
// the same store campaigns/metrics/activity already use.
import crypto from 'node:crypto';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

export function oauthConfigured() {
  return Boolean(URL_ && TOKEN && process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.OAUTH_LOGIN_PASSWORD);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** PKCE: verify a code_verifier against the code_challenge stored at /authorize time. */
export function pkceMatches(codeVerifier, codeChallenge, method) {
  if (!codeChallenge) return true; // PKCE not used by this client — allowed but not required here
  if (method && method !== 'S256') return false;
  const hash = crypto.createHash('sha256').update(codeVerifier || '').digest('base64url');
  return hash === codeChallenge;
}

const CODE_TTL = 120;          // seconds — authorization codes are single-use, short-lived
const ACCESS_TTL = 90 * 86400;  // seconds — 90 days
const REFRESH_TTL = 180 * 86400; // seconds — 180 days

/** Store a freshly-issued authorization code. Returns the code. */
export async function createAuthCode({ redirectUri, codeChallenge, codeChallengeMethod, clientId }) {
  const code = randomToken(24);
  await redis(['SET', `dwm:oauth:code:${code}`, JSON.stringify({ redirectUri, codeChallenge, codeChallengeMethod, clientId }), 'EX', String(CODE_TTL)]);
  return code;
}

/** Consume (read + delete, single-use) an authorization code. Null if unknown/expired/reused. */
export async function consumeAuthCode(code) {
  const key = `dwm:oauth:code:${code}`;
  const raw = await redis(['GET', key]);
  if (!raw) return null;
  await redis(['DEL', key]); // single-use — deleted whether or not the rest of the exchange succeeds
  try { return JSON.parse(raw); } catch { return null; }
}

/** Issue a fresh access + refresh token pair. */
export async function issueTokens() {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  await redis(['SET', `dwm:oauth:at:${accessToken}`, '1', 'EX', String(ACCESS_TTL)]);
  await redis(['SET', `dwm:oauth:rt:${refreshToken}`, '1', 'EX', String(REFRESH_TTL)]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL };
}

/** True if this bearer token is a currently-valid access token. */
export async function validAccessToken(token) {
  if (!token) return false;
  const r = await redis(['GET', `dwm:oauth:at:${token}`]);
  return Boolean(r);
}

/** Exchange a refresh token for a new access token. Rotates the refresh token too,
 *  so a leaked-and-later-stolen refresh token can only be replayed once. */
export async function rotateRefreshToken(refreshToken) {
  const key = `dwm:oauth:rt:${refreshToken}`;
  const r = await redis(['GET', key]);
  if (!r) return null;
  await redis(['DEL', key]);
  return issueTokens();
}

/** Revoke a single access or refresh token (used by /api/oauth/revoke, and by the
 *  dashboard's "disconnect Claude" action if you add one later). */
export async function revokeToken(token) {
  await Promise.all([
    redis(['DEL', `dwm:oauth:at:${token}`]),
    redis(['DEL', `dwm:oauth:rt:${token}`])
  ]);
}
