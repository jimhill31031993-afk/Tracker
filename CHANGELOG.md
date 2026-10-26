# Changelog

## Communication Tracker — Phase 1 (Demo / Disconnected)

Additive patch to the existing Site Control tracker. No existing feature, API route, table or SLA calculation was changed.

### Added
- **Communication Tracker page** (`comms.html`, nav tab "Communication Tracker"; shortened to "Comms" below 520 px so the existing top bar cannot overflow).
  - Lists **all active tasks straight from the existing `rows` table** (no second task register), grouped by counterparty (Customer / Vector team / Other / Not set).
  - Search + filters: project/WBS/counterparty text, counterparty type, status (running / on hold / not started), due state (uses the existing `computeRemaining` SLA function, unchanged).
  - Each task expands/collapses **independently** and shows tracking status + recent communication.
  - **View Communication History** pop-up (accessible dialog, focus trap, Escape) with columns: received/sent date-time, direction/type, sender/recipient email, response duration, summary (5–9 words).
  - **Download Excel (.xlsx)** per task: real Office Open XML workbook (history sheet with real date cells + task-info sheet).
  - Manual entry of received/sent messages (clearly labelled *Manual · not verified*), optional 5–9-word note, explicit reply linking, reply-match review/resolve.
  - **Reminders** — two visually distinct pop-up types (✉ red "Unanswered incoming email", 📅 blue "Weekly update due"), each with a close button, plus a **Reminder centre**, **Stop reminders / Resume reminders** (persisted per user).
  - **Preview demo data** toggle: fictional, in-memory, read-only, never saved, never mixed with real data.
- **Completed page**: two new buttons per completed task — *✉ History* and *⬇ Excel* (existing buttons/behaviour untouched).
- **API** `/api/comms/*` (`src/comms.js`), behind the same session check and per-user scoping as every other route. Feature flag: set Worker variable `COMMS_ENABLED=false` to switch the module off without redeploying code.
- **Database**: `schema_comms.sql` — 4 new tables (`comm_task_meta`, `comm_events`, `comm_settings`, `comm_reminder_state`). It does not alter or touch `rows`, `users`, `sessions`.
- Tests (`tests/`), docs (`docs/`), this changelog and `TEST_REPORT.md`.

### Changed (existing files — additive lines only, verified by test)
| File | Change |
|---|---|
| `src/index.js` | +1 import line, +7-line route block delegating `/api/comms/*` after the existing auth check |
| `public/common.js` | +1 nav link, +a small style injection for the narrow-screen nav label |
| `public/completed.js` | +2 buttons in each row, +2 click listeners |
| `public/completed.html` | +1 stylesheet link, +3 script tags |

### Not changed
`public/tracker.js`, `public/index.html`, `public/analytics.*`, `public/style.css`, `public/app.js`, `schema.sql`, `schema_update.sql`, `wrangler.jsonc`, README.md.

### Behaviour decisions to know about
- Reminder rules use **elapsed calendar time** (24 h; 6 days). No weekend/holiday adjustment. DST never shifts them.
- Weekly reminder = **one per counterparty group**, anchored on the latest *sent* event of any task in that group, or (if none) the earliest tracking start in the group — shown on the reminder as "counted from tracking start".
- Dismissing a pop-up closes **that cycle only**; the next 24 h cycle shows again. Resuming reminders clears closed cycles so everything currently due shows.
- A reply clears an unanswered reminder only if it is **explicitly linked** (or shares a thread reference). An unlinked sent message to the same address is flagged "Needs manual review" and does **not** clear anything.
- Reminder pop-ups appear on the Communication Tracker page (not on the existing Tracker dashboard, which was deliberately left untouched).
