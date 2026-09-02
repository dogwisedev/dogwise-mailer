// lib/analyticsCore.js — the actual aggregation behind api/analytics.js, factored out
// so api/mcp.js's get_analytics tool returns EXACTLY the same numbers the dashboard
// shows, computed by one piece of code rather than two that could quietly drift apart.
//
// CHANNEL NOTE: SMS steps never get pixel or click tracking (see lib/process.js — texts
// only ever bump the "sent" and, if the contact texts back, "replied" metrics). That
// means an SMS step's own opened/clicked count is always 0, and — more importantly —
// blending SMS "sent" into a sequence-wide denominator drags open/click rate down even
// though those sends were never capable of registering an open or click in the first
// place. So: per-step rates are null (not 0) for a channel that can't produce that
// metric, and sequence-level totals compute openRate/clickRate against the email-only
// send count, while still reporting total sent (and the email/sms split) for reach.
import {
  campaignFunnel, campaignLinks, campaignHourOfDay, campaignTimeToOpen, metricsConfigured
} from './metrics.js';
import { getCampaigns } from './store.js';

const rate = (n, d) => (d ? +(100 * (n || 0) / d).toFixed(1) : null);

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

    // channel decides which rates are even meaningful: 'sms' can never produce an
    // open or a click (no pixel, no tracked link today), so those come back null
    // instead of a misleading 0%. Replies are real on both channels.
    const stepMetrics = (m, i, subject, channel = 'email') => {
      const sent = m.sent || 0;
      const trackable = channel !== 'sms';
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
        openRate: trackable ? rate(m.opened, sent) : null,
        clickRate: trackable ? rate(m.clicked, sent) : null,
        replyRate: rate(m.replied, sent)
      };
    };

    // A/B steps record their funnel data under "<step>.<variantId>" keys (see
    // lib/process.js's pickVariant), never under the bare step number, so build the
    // per-variant breakdown from those keys and sum them for the step-level total.
    // Variants can be email OR sms (see registerTool's create_sequence description),
    // so the step's actual channel has to be threaded through here too — this used to
    // be hardcoded to 'email', which meant an SMS A/B step's open/click rate was
    // computed instead of suppressed.
    const variantMetrics = (i, variants, channel = 'email') => {
      const perVariant = variants.map(v => {
        const m = stepMetrics(funnel.steps[`${i + 1}.${v.id}`] || {}, i, v.subject || '', channel);
        return { id: v.id, ...m };
      });
      const summed = {};
      for (const pv of perVariant) {
        for (const k of ['sent', 'opened', 'openHits', 'clicked', 'clickHits', 'replied']) {
          summed[k] = (summed[k] || 0) + pv[k];
        }
      }
      const total = stepMetrics(summed, i, variants.map(v => v.subject).join(' / '), channel);
      return { ...total, variants: perVariant };
    };

    // Fixed-step sequences: walk the campaign's own step list. Checklist campaigns
    // have no fixed step list (reminder count is dynamic per contact), so instead
    // walk whatever step numbers actually have recorded activity in Redis — that's
    // the only place a checklist's real step count lives. (Checklist reminders are
    // always email today, so channel defaults to 'email' in that branch.)
    const steps = (all[key].steps || []).length
      ? all[key].steps.map((s, i) => {
          const channel = s.channel === 'sms' ? 'sms' : 'email';
          return Array.isArray(s.variants) && s.variants.length
            ? variantMetrics(i, s.variants, channel)
            : stepMetrics(funnel.steps[String(i + 1)] || {}, i, s.subject || '', channel);
        })
      : Object.keys(funnel.steps)
          .map(Number)
          .filter(n => n > 0)
          .sort((a, b) => a - b)
          .map(n => stepMetrics(funnel.steps[String(n)] || {}, n - 1, n === 1 ? (all[key].firstEmail?.subject || 'First email') : `Reminder ${n - 1}`));

    // Sequence-level totals. funnel.totals sums raw counts across every step
    // regardless of channel — fine for "sent" (that's genuine reach), wrong as the
    // denominator for open/click rate, since it silently includes untrackable SMS
    // sends. Rebuild the rates here against the email-only send count, and expose
    // the channel split so the UI (and Claude) can show it plainly instead of
    // implying every send had an equal shot at being opened.
    const sentEmail = steps.reduce((n, s) => n + (s.channel !== 'sms' ? s.sent : 0), 0);
    const sentSms = steps.reduce((n, s) => n + (s.channel === 'sms' ? s.sent : 0), 0);
    const t = funnel.totals || {};
    const totals = {
      ...t,
      sent: t.sent || 0,
      sentByChannel: { email: sentEmail, sms: sentSms },
      openRate: rate(t.opened, sentEmail),
      clickRate: rate(t.clicked, sentEmail),
      replyRate: rate(t.replied, t.sent)
    };

    out[key] = {
      label: all[key].label || key,
      type: all[key].type || 'sequence',
      totals,
      byDay: funnel.byDay,
      steps,
      links,
      hourOfDay: hod,
      timeToOpen: tto
    };
  }

  return { configured: true, campaigns: out };
}
