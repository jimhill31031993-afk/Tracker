# Communication Tracker — how it works (Phase 1)

**Mode: Demo/Disconnected.** It does not read Outlook. It never sends or drafts email. Every event is something you recorded by hand and is labelled *Manual · not verified*.

## Using it
1. **Set a counterparty** (Customer / Vector team / Other + name) on each task — expand the task → *Set counterparty*. Tasks sharing a counterparty share one weekly reminder. Tasks without one still get "unanswered email" reminders but no weekly reminder.
2. **Record a message** — expand a task → *Record received message* / *Record sent message* (date/time in the zone shown, sender/recipient, optional 5–9-word note). For a sent reply choose which received message it answers; leave "not sure" to have it flagged for review; choose "Not a reply" for e.g. a weekly update.
3. **Read history** — *View Communication History* (also on the Completed page). **Download Excel** exports the same table.
4. **Reminders** — see rules below. *Stop reminders* pauses pop-ups only.

## Reminder rules (elapsed calendar time; configurable in `public/comms-logic.js` → `DEFAULT_CONFIG`)
| Reminder | Starts | Repeats | Clears when |
|---|---|---|---|
| ✉ Unanswered incoming email | 24 h after the received time | every 24 h | the received message has an **explicitly linked** (or same-thread-reference) sent reply |
| 📅 Weekly update due | 6 days after the group's last sent message (or tracking start if none) | every 24 h while still due | any sent message is recorded for any active task of that counterparty |

No weekend/holiday adjustment. A Friday 17:00 email is flagged on Saturday 17:00.

## Summaries
No AI or message content is processed in Phase 1. A summary exists only if you type a 5–9-word note (labelled *Manual note*); otherwise the table says "Unavailable — message content not accessed".

## Data model
`comm_task_meta` (counterparty + tracking start per existing task id), `comm_events`, `comm_settings` (pause + time zone), `comm_reminder_state` (closed cycles). Times are stored in UTC and displayed in the zone you pick (default: your browser's zone).
