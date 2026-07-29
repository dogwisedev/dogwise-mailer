// api/health.js — post-deploy sanity check.
//
//   GET /api/health?secret=<ADMIN_PASSWORD>
//
// Two jobs:
//
//  1. Show the URLs the app will actually put in emails. APP_URL is easy to get subtly
//     wrong (missing scheme, trailing slash, markdown syntax pasted from a chat window),
//     and the only other way to find out is to send a real email and inspect it.
//
//  2. Prove every module resolves. Node links ESM imports before running anything, so a
//     missing or misnamed file takes the whole function down with a 500 in ~150ms and no
//     outgoing requests. Importing everything here surfaces that in one click instead of
//     waiting for a cron to fail.
import { appBaseUrl } from '../lib/util.js';

const MODULES = [
  '../lib/activity.js', '../lib/bounces.js', '../lib/checklist.js', '../lib/designs.js',
  '../lib/gmail.js', '../lib/hubspot.js', '../lib/links.js', '../lib/marketing.js',
  '../lib/metrics.js', '../lib/process.js', '../lib/region.js', '../lib/settings.js',
  '../lib/sms.js', '../lib/spamcheck.js', '../lib/store.js', '../lib/throttle.js',
  '../lib/tokens.js', '../lib/triggers.js', '../lib/util.js'
];

const ENV_KEYS = [
  'APP_URL', 'ADMIN_PASSWORD', 'CRON_SECRET', 'HUBSPOT_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'OPENPHONE_API_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY',
  'SENDER_ADDRESS', 'SENDER_NAME', 'MAX_PER_RUN', 'HUBSPOT_MIN_GAP_MS'
];

export default async function handler(req, res) {
  const secret = req.query.secret || '';
  const ok = (process.env.ADMIN_PASSWORD && secret === process.env.ADMIN_PASSWORD) ||
             (process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ error: 'unauthorized — pass ?secret=' });

  const base = appBaseUrl();
  const rawAppUrl = process.env.APP_URL || null;

  // Flag a raw value that needed cleaning up, so a bad env var is visible rather than
  // quietly corrected. It still works, but you probably want to fix the source.
  const notes = [];
  if (rawAppUrl && rawAppUrl.trim() !== base) {
    notes.push(`APP_URL was normalised from ${JSON.stringify(rawAppUrl)} to ${base} — worth correcting the env var itself`);
  }
  if (!rawAppUrl) {
    notes.push(`APP_URL is not set, so the base URL is inferred from the Vercel production domain (${base}). It will change if you change the primary domain.`);
  }

  const env = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    // Never echo secrets. Presence and length only, except for the non-secret ones.
    env[k] = v ? (['APP_URL', 'SENDER_NAME', 'SENDER_ADDRESS', 'MAX_PER_RUN', 'HUBSPOT_MIN_GAP_MS'].includes(k) ? v : `set (${v.length} chars)`) : 'MISSING';
  }

  const modules = {};
  for (const m of MODULES) {
    try { await import(m); modules[m.replace('../', '')] = 'ok'; }
    catch (e) { modules[m.replace('../', '')] = `FAILED — ${e.message}`; }
  }
  const broken = Object.entries(modules).filter(([, v]) => v !== 'ok').map(([k]) => k);

  return res.status(200).json({
    healthy: broken.length === 0 && env.HUBSPOT_TOKEN !== 'MISSING' && env.KV_REST_API_URL !== 'MISSING',
    baseUrl: base,
    urlsInEmails: {
      trackedLink: `${base}/api/c?e=<sendId>&i=0`,
      openPixel: `${base}/api/px?e=<sendId>`,
      unsubscribe: `${base}/api/unsubscribe?e=<sendId>`
    },
    notes,
    brokenModules: broken,
    modules,
    env
  });
}
