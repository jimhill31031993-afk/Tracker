# Site Control — Project Timeline Tracker
### Full publishing guide — real-time, shared data, 100% free on Cloudflare

This version stores data in **Cloudflare D1** (a free shared database), not
just in your browser — so everyone who opens the site sees and edits the
*same* live table. The countdown ticks every second on-screen; button
clicks sync to everyone else within a few seconds automatically.

## What's in this folder

```
index.html               — page + the Add / Edit / History popups
style.css                — styling
app.js                   — frontend logic (talks to /api/rows)
functions/
  api/
    rows.js              — GET (list) / POST (create) — Cloudflare Pages Function
    rows/[id].js          — PATCH (start/hold/edit/clear) — Cloudflare Pages Function
schema.sql                — the one-time database table setup
```

You need a free Cloudflare account. Everything below is done in the
Cloudflare dashboard in a browser — no command line required.

---

## Step 1 — Create the database

1. Go to **dash.cloudflare.com** → log in → in the left sidebar click
   **Workers & Pages** → the **D1 SQL Database** tab (or **Storage & Databases → D1**, naming varies slightly by account).
2. Click **Create database**.
3. Name it `site_control_db` (any name works, just remember it) → **Create**.
4. Open the new database → go to its **Console** tab.
5. Open `schema.sql` from this folder, copy its entire contents, paste
   into the console's query box, and click **Execute**.
6. Confirm it worked: run `SELECT * FROM rows;` — it should return an
   empty result with no error.

## Step 2 — Publish the site files

1. Back in **Workers & Pages**, click **Create** → **Pages** → **Upload assets**.
2. Project name: e.g. `site-control-tracker`.
3. Drag in the whole project folder (or a zip of it) — it must include
   the `functions/` folder alongside `index.html`, so Cloudflare
   auto-detects your two API routes.
4. Click **Deploy site**. You'll get a live address like
   `https://site-control-tracker.pages.dev` — don't open it yet, the
   buttons won't work until Step 3 is done.

*(If you'd rather connect a GitHub repo so every future push auto-deploys:
Create → Pages → Connect to Git → pick the repo → Framework preset:
**None** → Build command: leave blank → Build output directory: `/` →
Save and Deploy. Functions are picked up automatically the same way.)*

## Step 3 — Connect the database to the site

The site and the database exist separately until you bind them together:

1. Open your Pages project → **Settings** tab → **Functions** (left-hand
   sub-menu) → **D1 database bindings** → **Add binding**.
2. **Variable name:** type `DB` exactly (the code expects this name).
3. **D1 database:** select `site_control_db` from Step 1.
4. Click **Save**.
5. Bindings only apply to *new* deployments, so go to the **Deployments**
   tab and **Retry deployment** (or push any small change if using Git) —
   this redeploys with the database now attached.

## Step 4 — Test it

1. Open your `*.pages.dev` URL.
2. Click **+ Add new**, fill in the popup, **Submit** — a row should
   appear with a live, ticking Remaining time.
3. Click **Start**, then **Hold** — the button that's active should stay
   lit green/red until you click the other one, and the countdown should
   pause/resume accordingly.
4. Open the same URL in a second browser tab (or on your phone) — within
   a few seconds it should show the same row and the same live state.
   That confirms the shared database is working, not just your browser.
5. Click **🕒 History** on a row — you should see the Created/Start/Hold
   entries with timestamps.

If Add/Start/Hold don't do anything and the browser console (F12) shows
errors calling `/api/rows`, the most common cause is the binding name in
Step 3 not being exactly `DB`, or forgetting to redeploy after adding it.

---

## Notes

- **"Real-time" here means:** the on-screen countdown updates every
  second using your device's clock (genuinely live), and the table
  re-syncs with the shared database roughly every 4 seconds, so a change
  someone else makes shows up for you within a few seconds — this is
  normal, reliable "polling" rather than an instant push, and is the
  simplest approach that stays fully on Cloudflare's free tier. If you
  ever need sub-second cross-device sync (e.g. two people watching the
  exact same click happen instantly), that needs WebSockets/Durable
  Objects — a bigger, paid-tier-adjacent build; say so if you want it.
- **Free tier limits:** D1's free allowance (5GB storage, ~5M reads and
  100k writes/day) is far more than a project tracker like this will
  ever use.
- **Changing stage durations:** edit `STAGE_DURATIONS` near the top of
  `app.js` (used for the live countdown) — the numbers are also echoed
  in the dropdown option labels in `index.html`, so update both if you
  change one.
- **Custom domain:** once deployed, Pages project → **Custom domains**
  tab → add yours, free, no extra steps needed for the API routes.
