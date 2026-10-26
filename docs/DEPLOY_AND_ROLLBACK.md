# Applying the patch safely (GitHub web interface + Cloudflare)

You have **two ZIPs**. Use the **patch-only ZIP** for GitHub (it contains only new/changed files with their paths). Keep the **full ZIP** as a ready-to-run complete copy.

## 0. Before you touch anything
1. GitHub repo → green **Code** button → **Download ZIP** of the current `main`. Save it as your untouched backup (e.g. `Tracker-main-BACKUP-before-comms.zip`).
2. Nothing in this procedure deletes anything. **Do not delete repository files.** (The old README's "delete the old files" step does not apply to this patch.)

## 1. What the D1 migration does (read before running it)
`schema_comms.sql` only runs `CREATE TABLE IF NOT EXISTS …` and `CREATE INDEX IF NOT EXISTS …` for four new tables. It does not read, change or delete `rows`, `users` or `sessions`, and it is safe to run twice. Until it has been run, the new page shows a clear "run schema_comms.sql" message and **the rest of the tracker works exactly as before**.

**Important about preview builds:** your Worker's `wrangler.jsonc` binds the *production* D1 database. A preview of the new branch therefore talks to the same database. That is safe here (the migration is additive), but it means the migration is applied to production data's database. The tables stay empty until you add events.

Optional extra safety net: in the Cloudflare dashboard open `site_control_db` and check whether **Time Travel** (point-in-time restore) is available for your database before running the migration.

## 2. Create a separate branch (do NOT commit to `main`)
1. On the repo's main page click the branch dropdown (shows `main`).
2. Type `comms-tracker-phase1` → **Create branch: comms-tracker-phase1 from main**.
3. Make sure the dropdown now shows `comms-tracker-phase1`.

## 3. Upload the patch files to that branch
1. On your computer, **unzip the patch-only ZIP** (GitHub does not unzip for you). You should see folders `public/`, `src/`, `tests/`, `docs/` and files `schema_comms.sql`, `CHANGELOG.md`, `TEST_REPORT.md`.
2. In GitHub (branch `comms-tracker-phase1`): **Add file → Upload files**.
3. Drag the **contents** of the unzipped folder into the upload area (drag the folders themselves so the paths are kept). GitHub will show the file list — it should match `PATCH_FILE_LIST.txt` (4 modified files: `src/index.js`, `public/common.js`, `public/completed.js`, `public/completed.html`; the rest are new).
4. Commit message: `Add Communication Tracker Phase 1 (demo/disconnected)`; choose **Commit directly to the comms-tracker-phase1 branch**; **Commit changes**.
5. Check the commit's **Files changed** view: no file other than the four modified ones above should show deletions.

## 4. Run the migration
1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → site_control_db → Console**.
2. Open `schema_comms.sql`, copy all of it, paste into the Console, **Execute**. You should see four tables created.

## 5. Check the preview
1. Cloudflare → your Worker → **Settings → Build** (Workers Builds): confirm **non-production branch builds / preview URLs** are enabled, then open the **Deployments** tab and find the build for `comms-tracker-phase1` and its preview URL. (If previews are not enabled, enable them for this branch or tell me and we'll choose another path — do not merge to `main` just to test.)
2. On the preview URL, verify the **existing tracker first**: sign in, add a task, Start/Hold, close it, open Completed, Analytics. Existing 20%-remaining reminder pop-ups should behave as before.
3. Then open **Communication Tracker**: banner says *Demo/Disconnected*; tasks list matches the Tracker; use **Preview demo data** to see both reminder types; set a counterparty on a real task and record a manual event.
4. Completed page: each task has **✉ History** and **⬇ Excel**.

## 6. Promote (only after you are happy)
GitHub → **Compare & pull request** for `comms-tracker-phase1` → review **Files changed** → **Merge pull request**. Cloudflare then deploys `main` automatically.

## Rollback
- **Code, before merging:** do nothing — `main` is untouched. Delete the branch if you wish.
- **Code, after merging:** GitHub → the merged pull request → **Revert** (creates a new revert PR → merge it). Or Cloudflare → Worker → **Deployments** → select the previous deployment → **Rollback**.
- **Instant switch-off without redeploying:** Worker → Settings → Variables → add `COMMS_ENABLED` = `false`. The page then reports the module is switched off; the rest of the app is unaffected.
- **Database (removes only communication data; tasks are unaffected):** in the D1 Console run
  `DROP TABLE IF EXISTS comm_reminder_state; DROP TABLE IF EXISTS comm_settings; DROP TABLE IF EXISTS comm_events; DROP TABLE IF EXISTS comm_task_meta;`
