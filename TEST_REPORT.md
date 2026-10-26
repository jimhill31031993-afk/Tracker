# TEST REPORT — Communication Tracker Phase 1

Run date: 2026-10-26. Everything below was **actually executed in this session**; anything not executed is listed under "Not run / limitations".

## Commands run and results

| Command | Result |
|---|---|
| `node --test tests/*.test.mjs` | **54 tests, 54 pass, 0 fail, 0 skipped** |
| `tests/e2e/run.sh` (real Worker code + SQLite + headless Chromium 141 via Playwright; run repeatedly for stability) | **50/50 checks pass** on the last 4 consecutive runs (one earlier run exposed a race in the *test script*, fixed; no product change) |
| `node --check` on every `.js`/`.mjs` file in `src/`, `public/`, `tests/` | all parse |
| `openpyxl 3.1.5` (`tests/helpers/check_xlsx.py`) | opens every generated `.xlsx`; `zipfile.testzip()` reports no bad CRC |
| Patch applied to a clean copy of the original ZIP, then `node --test` again | see "Package verification" at the end |

The project has **no** `package.json`, linter, type-checker or build step, so there was nothing of that kind to run; none was invented. Test tooling is dev-only (Node ≥ 22.5 for `node:sqlite`, Playwright, openpyxl) and is **not** needed to deploy.

## What the automated tests prove

### Node tests (54)
- PASS  status is Demo/Disconnected and cannot be enabled
- PASS  overview reuses live `rows` (active only) and invents nothing
- PASS  counterparty: validated, stored as metadata, tracking start kept
- PASS  event creation: validation, manual/unverified labelling, no future dates
- PASS  duplicate events are prevented
- PASS  reply linking: only to an earlier received event on the same task
- PASS  resolving a suggested match: link or 'not a reply'; delete clears links
- PASS  history works for ACTIVE and COMPLETED tasks
- PASS  USER ISOLATION: user B cannot see or touch user A's data
- PASS  pause persists per user; resume clears closed displays; history keeps collecting
- PASS  dismiss only ever raises the dismissed cycle and validates input
- PASS  tasks deleted in the existing tracker leave no orphaned communication data
- PASS  missing migration gives a clear 503, not a crash
- PASS  feature flag: COMMS_ENABLED=false switches the module off
- PASS  NO mailbox capability: source scan of everything shipped
- PASS  duration formats match the specification examples
- PASS  summary must be 5-9 words
- PASS  missing summary is labelled unavailable, never invented
- PASS  Auckland wall time converts correctly outside DST changes
- PASS  spring-forward gap time is rejected, fall-back ambiguity is flagged
- PASS  24 elapsed hours across a DST change are still 24h of elapsed time
- PASS  formatting and parsing round-trip in the user's zone
- PASS  events sort chronologically, IN before OUT on equal timestamps
- PASS  explicitly linked reply pairs and computes response duration
- PASS  same thread reference pairs reliably
- PASS  uncertain match is NOT paired: flagged for manual review
- PASS  a sent message to someone else is standalone, not a reply
- PASS  'not a reply' resolves a suggested match without pairing
- PASS  a reply dated before the message is never paired
- PASS  unanswered reminder starts at 24h and repeats every 24h
- PASS  closing a popup dismisses that display only; next cycle shows again
- PASS  a linked sent reply clears the unanswered reminder; a status change does not
- PASS  weekly reminder appears at day 6 after the last sent message, not before
- PASS  weekly: no outgoing history counts from tracking start and says so
- PASS  weekly reminders group by counterparty: one per group, not per task
- PASS  one sent message on any task in the group resets the whole group
- PASS  weekly: one pop-up per due cycle, not duplicated for the same cycle
- PASS  completed tasks never produce reminders
- PASS  tasks with no counterparty get unanswered reminders but no weekly group
- PASS  pause turns off pop-ups only; due calculations continue
- PASS  export rows: labelled manual/unverified, summary unavailable, duration honest
- PASS  every pre-existing file is byte-identical except the 3 declared hook files
- PASS  index.js differs from the original only by the import and the /api/comms/ route
- PASS  common.js, completed.js and completed.html changes are purely additive
- PASS  existing task CRUD, status changes, close/complete, analytics, auth: identical before/after patch
- PASS  patched worker works even if the comms tables were never created
- PASS  /api/comms/* requires the existing session (401 when signed out)
- PASS  SLA helper functions in common.js are unchanged (loaded and compared)
- PASS  existing 20%-remaining reminder (tracker.js) is untouched and uses its own storage key
- PASS  xlsx opens in openpyxl; CRCs valid; real OOXML parts present
- PASS  xlsx content: headers, real date cells, durations, summaries, labels
- PASS  xlsx handles empty history, unicode, formula-like text and illegal XML chars
- PASS  export file names are safe and flag demo data
- PASS  sheet names are sanitised and unique; CRC32 matches known vector

### Browser end-to-end checks (50)
- PASS register
- PASS page shows only active tasks from existing rows
- PASS banner says Demo/Disconnected and not tracking Outlook
- PASS empty-events message shown
- PASS no fictional data in the default view
- PASS weekly popup for the group already 8 days without a sent message
- PASS weekly popup states tracking-start basis + manual-send wording
- PASS two distinct popup types
- PASS unanswered popup content
- PASS focus moved to first popup close button
- PASS Escape closes one popup only
- PASS closed popup stays closed after reload (same cycle), the other is still shown
- PASS reminder centre still lists the closed item
- PASS centre count is 2
- PASS pause hides popups
- PASS pause note visible; tracking continues
- PASS pause state persists across reload
- PASS due items still counted while paused
- PASS history collection continues while paused
- PASS resume recalculates and shows everything due
- PASS expanding one task does not expand others
- PASS two expanded independently
- PASS collapsing one leaves the other
- PASS word counter shows OK
- PASS verified-style claims absent: entry labelled manual
- PASS unanswered popup cleared by the linked reply
- PASS summary outside 5-9 words rejected
- PASS history columns
- PASS history header has task, counterparty, mode
- PASS response duration for linked reply (~3h, minute precision)
- PASS awaiting duration for the unanswered 2h item
- PASS missing summary is labelled unavailable, not invented
- PASS active-task .xlsx opens in openpyxl with 3 events
- PASS Escape closes history modal
- PASS completed task leaves active list and produces no reminders input
- PASS completed page has both buttons
- PASS existing time-breakdown button still present
- PASS completed history shows read-only note and no-reply wording
- PASS completed .xlsx valid and labelled Completed
- PASS demo banner is unmistakable
- PASS demo replaces (not mixes with) real tasks
- PASS demo shows both popup types with DEMO tag
- PASS demo record buttons disabled
- PASS leaving demo restores real data
- PASS demo wrote nothing to the database
- PASS search filters tasks
- PASS counterparty filter
- PASS unassigned filter (none left: all active tasks have a counterparty)
- PASS no horizontal page scroll at 390px
- PASS no JavaScript errors in the console

## Mapping to ACCEPTANCE_TESTS.md

| Item | Status | Evidence |
|---|---|---|
| Existing task create/edit/delete/close/complete unchanged | **Pass** (API level) | Identical 27-step scenario run against the *original* and *patched* Worker with matching normalised responses; `tracker.js`, `index.html` byte-identical |
| SLA calculations, statuses, analytics, auth, import/export | **Pass** (API + function level) | Same scenario incl. analytics routes; `computeRemaining` compared for 5 stages × 3 states, `elapsedWorkingSeconds` for 8 durations, `STAGE_DURATIONS` table compared |
| Communication Tracker is an extra page; reuses `rows`; no destructive migration | **Pass** | New `comms.html`; overview reads `rows`; table list test; additive `CREATE TABLE IF NOT EXISTS`; only 4 existing files differ, additive lines only |
| Events show timestamps, direction, address, response duration, summary | **Pass** | Browser history-modal checks |
| AI summaries of 5–9 words | **Not applicable in Phase 1** | No AI/content access exists. Manual notes are enforced to 5–9 words (client + server); otherwise "Unavailable" |
| Pair only when reliable; unknown flagged for review | **Pass** | Unit tests (explicit link, thread ref, unlinked → REVIEW, not-a-reply, reply-before-message) |
| Per-task modal; independent expand/collapse | **Pass** | Browser checks |
| Valid `.xlsx` for active and completed tasks | **Pass** (openpyxl) | Browser downloads re-opened with openpyxl; real date cells; XML-special/formula-like/illegal characters handled |
| Duplicates prevented; timestamps/time zones/DST | **Pass** (Node ICU) | API 409 test; Pacific/Auckland gap, ambiguity and 23-real-hour day tests |
| 24 h unanswered, 24 h repeat, clears on linked reply | **Pass** | Unit + browser |
| Weekly at day 6, grouped by counterparty, no per-task duplicates | **Pass** | Unit tests + browser |
| Completed tasks produce no reminders; history/Excel kept | **Pass** | Unit, API, browser (Completed page) |
| Close = that display only; Stop/Resume persist; tracking continues; recalculation on resume | **Pass** | API persistence test + browser reload checks |
| Demo/Disconnected default; fictional data separate; no sync claim | **Pass** | Banner text check; demo-writes-nothing check (DB identical before/after) |
| No password/cookie/credential handling; no send/draft/write; connector stays disabled | **Pass** (static) | Source scan of all shipped new JS for Graph URLs, mail permissions, send/draft, tokens, cookies, browser storage; status is a frozen constant |
| No secrets in browser code, source control, logs, exports | **Pass** (static, new files only) | Scan above; exports contain only task/event data |
| User isolation | **Pass** | 404 for every cross-user read/write; empty overview/settings for second user |
| Lint/typecheck/test/build reported | **Pass / N/A** | See commands table; none exist besides tests |
| Full ZIP, patch ZIP, CHANGELOG, TEST_REPORT, GitHub steps, rollback | **Delivered** | `docs/DEPLOY_AND_ROLLBACK.md` |

## Not run / limitations (please read)
1. **Not run on Cloudflare.** `wrangler`/`workerd` are unavailable offline, so the Worker code ran in Node with `node:sqlite` standing in for D1 (same SQL dialect). `schema_comms.sql` was executed on SQLite 3.51, **not on D1 itself**. First real confirmation will be your preview deployment + running the migration.
2. **Excel**: validated with `openpyxl` only. Not opened in Microsoft Excel or LibreOffice.
3. **Browsers**: Chromium 141 only (desktop 1280 px and a 390 px emulated phone viewport). Not tested in Safari, Firefox or on real phones.
4. **Accessibility**: Escape, focus placement, focus trap, labels and non-colour cues were checked programmatically/visually. No screen-reader session and no automated audit (e.g. axe) was run.
5. **Existing Tracker page** (`index.html`/`tracker.js`) is byte-identical and was not driven in the browser; the existing 20 %-remaining reminder was therefore verified only as "file unchanged, separate storage key".
6. **Time zones** were unit-tested for Pacific/Auckland (+ UTC); the browser formatting relies on the browser's `Intl`.
7. **Scale**: not load-tested. The overview endpoint returns all events of active tasks (no pagination) — fine for personal volumes.
8. **Security review** was static (code reading + scan). No penetration test. New routes inherit the existing session cookie model.
9. Real Outlook data was never used; all test data is fictional (`example.test`, `demo.test`).

## Known behaviours (by design, not bugs)
- Pop-ups appear on the Communication Tracker page, not on the existing Tracker dashboard (left untouched).
- A manually linked reply clears the reminder but is still labelled *not verified*.
- Events can only be added/deleted on **active** tasks (completed history is read-only). There is no edit-event form: delete and re-add.
- Counterparty edits move a task between weekly groups immediately.

## Package verification
- The **patch-only ZIP** was extracted over a fresh copy of your original `Tracker-main.zip`: the result is byte-identical (45 files, SHA-256 compared) to the **full-source ZIP**.
- `node --test tests/*.test.mjs` on both the patched-original and the extracted full ZIP: **54/54 pass**. `tests/e2e/run.sh` on the extracted full ZIP: **50/50 pass**.
- Both ZIPs pass `zipfile.testzip()`. No original file is deleted by the patch (`DELETED: none` in `PATCH_FILE_LIST.txt`).
