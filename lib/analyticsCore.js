// lib/analyticsCore.js — the actual aggregation behind api/analytics.js, factored out
// so api/mcp.js's get_analytics tool returns EXACTLY the same numbers the dashboard
// shows, computed by one piece of code rather than two that could quietly drift apart.
import {
  campaignFunnel, campaignLinks, campaignHourOfDay, campaignTimeToOpen, metricsConfigured
} from './metrics.js';
import { getCampaigns } from './store.js';

/**
 * @param {string[]|null} requestedKeys  specific campaign keys, or null/[] for all
 * @param {number} days
 * @returns {{ configured: boolean, campaigns: object }}
 */
export async function buildCampaignAnalytics(requestedKeys, days = 14) {
  if (!metricsConfigured()) return { configured: false, campaigns: {} };

  const all = await getCampaigns();
  const keys = (requestedKeys && requestedKeys.length ? requestedKeys : Object.keys(all)).filter(k => all[k]);

  const out = {};
  for (const key of keys) {
    const [funnel, links, hod, tto] = await Promise.all([
      campaignFunnel(key, days),
      campaignLinks(key),
      campaignHourOfDay(key),
      campaignTimeToOpen(key)
    ]);

    const stepMetrics = (m, i, subject, channel = 'email') => {
      const sent = m.sent || 0;
      return {
        step: i + 1,
        channel,
        subject,
        sent,
        opened: m.opened || 0,
        openHits: m.open_hit || 0,
        clicked: m.clicked || 0,
        clickHits: m.click_hit || 0,
        replied: m.replied || 0,
        openRate: sent ? +(100 * (m.opened || 0) / sent).toFixed(1) : null,
        clickRate: sent ? +(100 * (m.clicked || 0) / sent).toFixed(1) : null,
        replyRate: sent ? +(100 * (m.replied || 0) / sent).toFixed(1) : null
      };
    };

    // A/B steps record their funnel data under "<step>.<variantId>" keys (see
    // lib/process.js's pickVariant), never under the bare step number, so build the
    // per-variant breakdown from those keys and sum them for the step-level total.
    const variantMetrics = (i, variants) => {
      const perVariant = variants.map(v => {
        const m = stepMetrics(funnel.steps[`${i + 1}.${v.id}`] || {}, i, v.subject || '', 'email');
        return { id: v.id, ...m };
      });
      const summed = {};
      for (const pv of perVariant) {
        for (const k of ['sent', 'opened', 'openHits', 'clicked', 'clickHits', 'replied']) {
          summed[k] = (summed[k] || 0) + pv[k];
        }
      }
      const total = stepMetrics(summed, i, variants.map(v => v.subject).join(' / '), 'email');
      return { ...total, variants: perVariant };
    };

    // Fixed-step sequences: walk the campaign's own step list. Checklist campaigns
    // have no fixed step list (reminder count is dynamic per contact), so instead
    // walk whatever step numbers actually have recorded activity in Redis — that's
    // the only place a checklist's real step count lives.
    const steps = (all[key].steps || []).length
      ? all[key].steps.map((s, i) => Array.isArray(s.variants) && s.variants.length
          ? variantMetrics(i, s.variants)
          : stepMetrics(funnel.steps[String(i + 1)] || {}, i, s.subject || '', s.channel === 'sms' ? 'sms' : 'email'))
      : Object.keys(funnel.steps)
          .map(Number)
          .filter(n => n > 0)
          .sort((a, b) => a - b)
          .map(n => stepMetrics(funnel.steps[String(n)] || {}, n - 1, n === 1 ? (all[key].firstEmail?.subject || 'First email') : `Reminder ${n - 1}`));

    out[key] = {
      label: all[key].label || key,
      type: all[key].type || 'sequence',
      totals: funnel.totals,
      byDay: funnel.byDay,
      steps,
      links,
      hourOfDay: hod,
      timeToOpen: tto
    };
  }

  return { configured: true, campaigns: out };
}
