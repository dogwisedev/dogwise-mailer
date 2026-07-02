# dogwise-mailer

Sequence email sender for Dogwise Academy. Sweeps HubSpot contacts on a cron, resolves each contact's **deal owner**, personalizes the step template, and sends directly from that owner's Gmail via domain-wide delegation. Every send is logged back to the contact's HubSpot timeline.

No HubSpot marketing contacts required.

## How it works

```
Vercel cron (every 30 min)
  → GET /api/cron
    → HubSpot search: dw_campaign set AND dw_next_send <= now AND not opted out
    → for each contact:
        contact → deals → newest deal → hubspot_owner_id → owner email
        personalize step template ({{firstname}}, {{sender_firstname}})
        Gmail API send AS the deal owner
        log email engagement to contact timeline
        bump dw_campaign_step, set dw_next_send = now + step delay
```

Sequence state lives in 3 contact properties (create these in HubSpot → Settings → Properties → Contact):

| Property | Type | Purpose |
|---|---|---|
| `dw_campaign` | Single-line text | Campaign key from campaigns.json |
| `dw_campaign_step` | Number | Next step to send (starts at 1) |
| `dw_next_send` | Date picker* | When the next step is due |

*If you use a HubSpot **datetime** property, values are epoch milliseconds — which is exactly what this app writes. A plain single-line text property also works fine.

## The dashboard (for the team)

Open `https://<your-app>.vercel.app` → enter the team password (`ADMIN_PASSWORD`). Staff can:
- Edit the **Welcome Email** (pinned, always exists, can't be deleted)
- Create multi-step campaigns: write each email, set "wait N days" between them, insert `{{firstname}}`-style tokens with one click
- **Send me a test** — emails step 1 to themselves exactly as a lead would get it
- Changes save to the database and go live on the next cron run — no deploys

## Setup

1. **Create the 3 contact properties** above in HubSpot.
2. **Push this repo to GitHub**, import into Vercel.
3. **Environment variables** (Vercel → Project → Settings → Environment Variables):

| Var | Value |
|---|---|
| `GOOGLE_SA_EMAIL` | `client_email` from the service account JSON |
| `GOOGLE_SA_KEY` | `private_key` from the JSON (paste whole thing incl. BEGIN/END lines) |
| `HUBSPOT_TOKEN` | Private app token (scopes: crm.objects.contacts read+write, crm.objects.deals.read, crm.objects.owners.read, sales-email-read or crm.objects.emails write) |
| `CRON_SECRET` | Any long random string — protects cron + enroll |
| `ADMIN_PASSWORD` | Team password for the dashboard |
| `MAX_PER_RUN` | Optional, default 40 |
| `MAX_PER_SENDER_PER_RUN` | Optional, default 15 |
| `SEND_TZ` / `SEND_START_HOUR` / `SEND_END_HOUR` | Optional, default America/New_York 8–18 |

4. **Add the database**: Vercel project → Storage tab → Create → **Upstash for Redis** (free tier). This injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically. Without it the dashboard is read-only (campaigns.json seed).
5. **Deploy.** The cron in `vercel.json` registers automatically.

## Test the delegation

```
https://<your-app>.vercel.app/api/test-send?as=you@dogwiseacademy.com&to=you@dogwiseacademy.com&secret=<CRON_SECRET>
```

Expected: `{ ok: true, gmailMessageId: ... }` and the email in your inbox, sent from your own address. Common failures:
- `unauthorized_client` → delegation not authorized for this client ID / scope in admin.google.com, or takes a few minutes to propagate
- `invalid_grant` → the `as=` address isn't a real Workspace user

## Enroll contacts

**Option A — HubSpot workflow (recommended for new leads):** workflow on your trigger property → "Set property value" × 3: `dw_campaign = new_lead_welcome`, `dw_campaign_step = 1`, `dw_next_send` = enrollment date. (For text-type `dw_next_send`, use a webhook action to `POST /api/enroll` instead.)

**Option B — API (extension / curl):**
```bash
curl -X POST https://<app>.vercel.app/api/enroll \
  -H "Authorization: Bearer <CRON_SECRET>" -H "Content-Type: application/json" \
  -d '{"campaign":"new_lead_welcome","contactIds":["101","102"],"startInDays":0}'
```

## Unenrollment

- Clearing `dw_campaign` (or `dw_next_send`) stops all future sends — make a HubSpot workflow that clears them when lifecycle stage changes, a meeting is booked, or the contact replies.
- Contacts with `hs_email_optout = true` are never picked up.

## Adding campaigns

Add a block to `campaigns.json` — key, label, steps with `subject`, `body`, `delayDaysAfter` (days until the *next* step; `null` on the last step). Tokens: `{{firstname}}`, `{{lastname}}`, `{{sender_firstname}}`, `{{sender_lastname}}`. Redeploy.

## Safety rails built in

- Send window (default 8am–6pm ET) — cron runs outside it no-op
- Per-run cap and per-sender cap; overflow defers to the next run (cron every 30 min naturally spreads volume)
- Opt-out respected on every sweep
- All sends logged to the HubSpot contact timeline

## Not yet built (v2 candidates)

- **Reply detection** (auto-unenroll on reply) — needs `gmail.readonly` scope added to the delegation; happy to add
- Open/click tracking (pixel + link redirects)
- Per-sender *daily* (cross-run) caps via a small KV store
