UPLOAD 2 of 2 — these REPLACE six existing files.

Built from your repo at commit b7302d7 (24 Jul, "Update region.js"). If you have
pushed anything since then, tell me and I'll rebase these — do NOT overwrite
newer work.

Drag the CONTENTS of this folder onto your repo root, overwriting when asked.

  lib/process.js      +68 lines  marketing branch, bounce skip, unsubscribe headers
  lib/gmail.js        +47 lines  optional extra headers, bounce reader
  api/campaigns.js    +10 lines  lets a marketing step save without a body
  api/test-send.js    +32 lines  send yourself a design preview
  public/index.html  +164 lines  Marketing button, design picker modal, CSS
  vercel.json          +4 lines  hourly bounce-sweep cron

Existing behaviour is unchanged. Verified:
  - buildMime() output is byte-identical for normal sends (tested against the old
    version across plain, multipart, and emoji/accent cases)
  - the non-marketing email path in process.js is the same three lines as before
  - all files pass node --check; the inline JS in index.html parses clean

After deploy, run one existing sequence end to end and confirm the email looks
exactly as it did.

The Marketing button will appear but has nothing to point at until you build the
drag-and-drop editor into public/marketing/ — that's a separate later step.
