// api/mcp.js — the actual MCP tool server. One McpServer instance is built fresh per
// request (stateless mode — sessionIdGenerator: undefined), which matches how Vercel's
// serverless functions work: no long-lived process to keep session state in, so we
// don't try to. Every tool call is a self-contained request against your existing
// lib/ functions — the same ones the dashboard and cron use, nothing new underneath.
//
// AUTH: every request needs `Authorization: Bearer <access_token>` from the OAuth flow
// in api/oauth/*.js. A missing/invalid token gets a 401 with a WWW-Authenticate header
// pointing at the protected-resource metadata, so a spec-compliant client knows to go
// log in rather than just failing silently.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { validAccessToken } from '../lib/oauth.js';
import { getCampaigns, saveCampaigns } from '../lib/store.js';
import { validCampaign } from './campaigns.js';
import { findContactByEmail, updateContact } from '../lib/hubspot.js';
import { buildCampaignAnalytics } from '../lib/analyticsCore.js';
import { dayRange } from '../lib/metrics.js';
import { getEvents, getAllTimeStats } from '../lib/activity.js';
import { appBaseUrl } from '../lib/util.js';

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function buildServer() {
  const server = new McpServer({ name: 'dogwise-mailer', version: '1.0.0' });

  server.registerTool('list_sequences', {
    description: 'List every sequence (campaign): key, label, type (sequence/checklist), step count, and whether A/B testing or send-time optimization is on for it.'
  }, async () => {
    const all = await getCampaigns();
    const list = Object.entries(all).map(([key, c]) => ({
      key, label: c.label || key, type: c.type || 'sequence',
      steps: (c.steps || []).length,
      hasVariants: (c.steps || []).some(s => Array.isArray(s.variants) && s.variants.length > 0),
      sendOptimization: c.sendOptimization?.enabled || false
    }));
    return textResult(list);
  });

  server.registerTool('get_sequence', {
    description: 'Get the full definition of one sequence by key — every step, its subject/body (or A/B variants), delay, channel, send window, and settings. Use list_sequences first if you don\u2019t know the key.',
    inputSchema: { key: z.string().describe('Campaign key, e.g. "welcome"') }
  }, async ({ key }) => {
    const all = await getCampaigns();
    if (!all[key]) return errorResult(`No sequence with key "${key}". Call list_sequences to see valid keys.`);
    return textResult(all[key]);
  });

  server.registerTool('save_sequence', {
    description: 'Create a new sequence, or overwrite an existing one entirely, by key. Pass the FULL campaign object (label, steps, etc — same shape get_sequence returns), not a partial patch. For small edits to one existing sequence, prefer update_sequence_step instead, which is safer. Steps: [{channel:"email"|"sms", subject, body, delayDaysAfter, days:{weekday,weekend}}] — or, for A/B testing, replace subject/body on a step with variants:[{id:"A",subject,body},{id:"B",subject,body}] (email or SMS steps only, not marketing-design steps).',
    inputSchema: {
      key: z.string().regex(/^[a-z0-9_]+$/).describe('Lowercase letters, numbers, underscores only'),
      campaign: z.record(z.any()).describe('The full campaign object to save')
    }
  }, async ({ key, campaign }) => {
    const problem = validCampaign(campaign);
    if (problem) return errorResult(problem);
    if (campaign.type !== 'checklist' && campaign.steps?.length) {
      campaign.steps[campaign.steps.length - 1].delayDaysAfter = null; // last step never delays, same rule the dashboard enforces
    }
    const all = await getCampaigns();
    all[key] = campaign;
    await saveCampaigns(all);
    return textResult({ ok: true, key });
  });

  server.registerTool('update_sequence_step', {
    description: 'Edit one field on one step of an existing sequence (subject, body, delayDaysAfter, or channel) without having to resend the whole sequence. Use get_sequence first to see current step indices (0-based) and content.',
    inputSchema: {
      key: z.string(),
      stepIndex: z.number().int().min(0).describe('0-based index into the steps array'),
      subject: z.string().optional(),
      body: z.string().optional(),
      delayDaysAfter: z.number().min(0).optional().describe('Days to wait after the previous step before sending this one'),
    }
  }, async ({ key, stepIndex, subject, body, delayDaysAfter }) => {
    const all = await getCampaigns();
    const c = all[key];
    if (!c) return errorResult(`No sequence with key "${key}".`);
    if (c.type === 'checklist') return errorResult('Checklist campaigns don\u2019t have numbered steps — use save_sequence with the firstEmail/intros/blocks fields instead.');
    const step = c.steps?.[stepIndex];
    if (!step) return errorResult(`Sequence "${key}" has no step at index ${stepIndex} (it has ${c.steps?.length || 0} steps).`);
    if (subject != null) step.subject = subject;
    if (body != null) step.body = body;
    if (delayDaysAfter != null) step.delayDaysAfter = delayDaysAfter;
    const problem = validCampaign(c);
    if (problem) return errorResult(problem);
    await saveCampaigns(all);
    return textResult({ ok: true, key, stepIndex, step });
  });

  server.registerTool('delete_sequence', {
    description: 'Delete a sequence by key. The "welcome" sequence and any checklist-type campaign can\u2019t be deleted (only edited) — same rule the dashboard enforces.',
    inputSchema: { key: z.string() }
  }, async ({ key }) => {
    const all = await getCampaigns();
    if (key === 'welcome') return errorResult('The welcome email can be edited but not deleted.');
    if (all[key]?.type === 'checklist') return errorResult('Checklist campaigns can be edited but not deleted.');
    if (!all[key]) return errorResult(`No sequence with key "${key}".`);
    delete all[key];
    await saveCampaigns(all);
    return textResult({ ok: true, deleted: key });
  });

  server.registerTool('enroll_contact', {
    description: 'Enroll one contact (by email) into a sequence, starting at step 1. Fails clearly if the email isn\u2019t found in HubSpot or the sequence key doesn\u2019t exist.',
    inputSchema: {
      email: z.string().email(),
      campaign: z.string().describe('Sequence key — see list_sequences'),
      startInDays: z.number().min(0).optional().describe('Delay before the first send, in days. Default 0 (send window permitting).')
    }
  }, async ({ email, campaign, startInDays = 0 }) => {
    const all = await getCampaigns();
    if (!all[campaign]) return errorResult(`No sequence with key "${campaign}". Call list_sequences to see valid keys.`);
    const contact = await findContactByEmail(email);
    if (!contact) return errorResult(`No HubSpot contact found with email "${email}".`);
    const firstSend = Date.now() + startInDays * 24 * 60 * 60 * 1000;
    await updateContact(contact.id, { dw_campaign: campaign, dw_campaign_step: '1', dw_next_send: String(firstSend) });
    return textResult({ ok: true, contactId: contact.id, email, campaign });
  });

  server.registerTool('get_analytics', {
    description: 'Sent/opened/clicked/replied funnel data per sequence, per step (and per A/B variant where set up), plus which links get clicked and when opens happen. This is the real, current data behind the dashboard\u2019s Reports tab — use it to answer questions like "which email underperforms" or "did variant A beat variant B".',
    inputSchema: {
      campaigns: z.array(z.string()).optional().describe('Specific sequence keys, or omit for all'),
      days: z.number().int().min(1).max(90).optional().describe('Lookback window in days, default 14')
    }
  }, async ({ campaigns, days = 14 }) => {
    const { configured, campaigns: out } = await buildCampaignAnalytics(campaigns, days);
    if (!configured) return errorResult('Analytics storage (Upstash Redis) isn\u2019t configured on this deployment.');
    return textResult({ days: dayRange(days), campaigns: out });
  });

  server.registerTool('get_activity', {
    description: 'Recent send/open/click/reply/error events (most recent first), plus today/this-week/all-time totals. Good for "what\u2019s happened recently" or debugging a specific failure.',
    inputSchema: { limit: z.number().int().min(1).max(2000).optional().describe('Max events to return, default 300') }
  }, async ({ limit = 300 }) => {
    const [events, allTime] = await Promise.all([getEvents(limit), getAllTimeStats()]);
    return textResult({ events, allTime });
  });

  return server;
}

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!(await validAccessToken(token))) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized — sign in first.' },
      id: null
    });
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: `Internal server error: ${e.message}` }, id: null });
    }
  }
}
