// api/unsubscribe.js — public one-click opt-out for marketing emails.
//
// The token is the existing send id (`${contactId}.${step}.${base36}`), so the contact id
// is just the first segment — no new schema, no new Redis key.
//
// GET  renders a confirmation page. It does NOT opt anyone out.
//      This matters: corporate mail scanners and Gmail's link prefetcher follow GET links,
//      and a GET that mutates would silently unsubscribe people who never clicked.
// POST performs the opt-out by setting hs_email_optout on the HubSpot contact, which
//      lib/process.js already checks first thing (`if (p.hs_email_optout === 'true') skip`).
import { updateContact } from '../lib/hubspot.js';
import { logEvent } from '../lib/activity.js';

const BRAND = process.env.BRAND_NAME || 'Dogwise Academy';

function page({ title, message, token, showButton }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
       background:#F4F6F9;color:#1E2A38;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border-radius:14px;padding:38px 34px;max-width:440px;width:100%;
        box-shadow:0 2px 14px rgba(27,79,138,.09);text-align:center}
  h1{font-size:19px;margin:0 0 10px}
  p{color:#5A6a7b;margin:0 0 22px}
  button{background:#1B4F8A;color:#fff;border:0;border-radius:7px;padding:13px 30px;
         font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#16406f}
  .small{font-size:12px;color:#98a3b0;margin:20px 0 0}
</style></head><body><div class="card">
<h1>${title}</h1><p>${message}</p>
${showButton ? `<button id="go">Unsubscribe me</button>` : ''}
<p class="small">${BRAND}</p>
</div>
${showButton ? `<script>
document.getElementById('go').onclick=async function(){
  this.disabled=true; this.textContent='Working…';
  try{
    const r=await fetch(location.pathname+'?e='+encodeURIComponent(${JSON.stringify(token)}),{method:'POST'});
    const d=await r.json();
    document.querySelector('.card').innerHTML= r.ok
      ? '<h1>You\\'re unsubscribed</h1><p>You won\\'t get any more marketing emails from us.</p><p class="small">${BRAND}</p>'
      : '<h1>Something went wrong</h1><p>'+(d.error||'Please reply to the email and we\\'ll remove you by hand.')+'</p>';
  }catch(e){
    document.querySelector('.card').innerHTML='<h1>Something went wrong</h1><p>Please reply to the email and we\\'ll remove you by hand.</p>';
  }
};
</script>` : ''}
</body></html>`;
}

export default async function handler(req, res) {
  const token = String(req.query?.e || '');
  const contactId = token.split('.')[0];

  if (!/^\d+$/.test(contactId)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(page({
      title: 'Link not recognised',
      message: 'This unsubscribe link looks incomplete. Reply to the email and we\u2019ll remove you by hand.',
      showButton: false
    }));
  }

  if (req.method === 'POST') {
    try {
      await updateContact(contactId, { hs_email_optout: 'true', dw_campaign: '', dw_next_send: '' });
      try {
        await logEvent({ type: 'skipped', contact: `contact ${contactId}`, detail: 'unsubscribed via marketing email footer' });
      } catch { /* logging is non-fatal */ }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Could not update your preferences just now' });
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(page({
    title: 'Unsubscribe',
    message: 'Confirm and we\u2019ll stop sending you marketing emails. This won\u2019t affect messages about a booking you already have with us.',
    token,
    showButton: true
  }));
}
