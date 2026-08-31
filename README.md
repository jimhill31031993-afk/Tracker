# Site Control — Project Timeline Tracker
### Corrected setup — Cloudflare Worker with static assets + D1

Your Cloudflare project deployed as a **Worker with static assets**
(Cloudflare's current recommended setup for new projects), not a classic
Pages project. That's totally fine — it's actually simpler once set up
correctly — but it needs a different file layout than before: one
Worker script that handles both the API and the website, plus a config
file (`wrangler.jsonc`) that defines the D1 binding directly. This
avoids the dashboard "Add binding" step entirely.

## What's in this folder

```
public/
  index.html       — page + popups
  style.css        — styling
  app.js           — frontend logic (talks to /api/rows)
src/
  index.js         — the ONE Worker script: serves the site AND the API
wrangler.jsonc      — config: names the Worker, points to public/, defines the DB binding
schema.sql           — one-time database table setup (same as before)
```

## Step 1 — Get your D1 database ID

1. **dash.cloudflare.com** → **Storage & Databases** (or **Workers & Pages**) → **D1 SQL Database** → open `site_control_db`.
2. On its **Overview** tab, near the top, there's a long ID like
   `3bad9dad-4bf8-4e98-acd8-c2e3711359bc` — copy it.
3. Open `wrangler.jsonc` in this folder and check the `database_id` line
   already matches what you copied. If your ID is different, replace it there.

*(If you haven't created the table yet: same as before — that database's
**Console** tab → paste in `schema.sql`'s contents → **Execute**.)*

## Step 2 — Replace the files in your GitHub repo

Your repo currently has the old Pages-style layout (`functions/`,
`index.html` at the root, etc.) — that won't work for a Worker, so
replace it entirely:

1. Go to your GitHub repo (the one Cloudflare is already connected to).
2. Delete the old files: `functions/` folder, and the old root-level
   `index.html`, `style.css`, `app.js`.
   (Click each file → the trash/delete icon → commit the deletion —
   or delete the whole repo content and start the upload fresh.)
3. **Add file → Upload files** → drag in this entire folder's contents,
   keeping the structure: `public/`, `src/`, `wrangler.jsonc`, `schema.sql`.
4. Commit directly to `main`.
5. Confirm afterward that your repo shows `src/index.js`, `wrangler.jsonc`,
   and `public/index.html` etc. — not `functions/`.

Because your Worker is Git-connected, Cloudflare will detect the push
and automatically start a new build/deployment within a minute or two —
watch the **Deployments** tab on your Worker's dashboard page.

## Step 3 — Verify the binding came through automatically

1. Once that new deployment finishes, go to your Worker's **Overview**
   tab in the Cloudflare dashboard.
2. The **Bindings** box in the diagram should now show **1** (not 0),
   because `wrangler.jsonc` defined it — no manual "Add binding" needed.
3. If it still shows 0: open **Settings** → look for **Build** or
   **Deploy configuration** and confirm the build is reading
   `wrangler.jsonc` from the repo root (this is automatic in virtually
   all cases, but worth a glance if something's off).

## Step 4 — Test it

1. Open your Worker's URL (shown at the top of Overview, something like
   `tracker.jimhill-31031993.workers.dev`).
2. **+ Add new** → fill in the popup → **Submit** — a row should appear
   with a live, ticking Remaining time.
3. Click **Start**, then **Hold** — confirm the active one stays lit and
   the countdown pauses/resumes.
4. Open the same URL in a second tab/device — within a few seconds it
   should show the same data, confirming the shared database is working.
5. **🕒 History** on a row should show the Created/Start/Hold log.

If Add/Start/Hold do nothing, open your browser's DevTools (F12) →
**Console** tab and check for a red error mentioning `/api/rows` — that
error message will say exactly what's wrong (e.g. "table not found"
means Step 1's schema wasn't run; a 500 error usually means the
`database_id` in `wrangler.jsonc` doesn't match your actual database).

---

## Notes

- **No more dashboard binding wrestling.** Because the binding lives in
  `wrangler.jsonc` inside your repo, every future deployment carries it
  automatically — nothing to re-click.
- **"Real-time" here** means the on-screen countdown ticks every second
  off your device's clock, and re-syncs with the shared database every
  ~4 seconds — so another person's click shows up for you within a few
  seconds. That's normal, reliable "polling," and the simplest approach
  that stays on Cloudflare's free tier.
- **Custom domain:** Worker's dashboard page → **Domains** tab →
  **Add Domain**, free, same as before.
- **Changing stage durations:** edit `STAGE_DURATIONS` near the top of
  `public/app.js`, and update the matching option labels in
  `public/index.html`.
