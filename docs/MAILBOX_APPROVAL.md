# Future read-only mailbox integration — approval pack (NOT implemented)

**Status: nothing in this patch connects to Outlook or Microsoft 365.** There is no OAuth code, no Microsoft Graph call, no token handling and no connector switch. `/api/comms/status` always reports `DEMO_DISCONNECTED`; the value is a frozen constant, not a setting. Do not enable anything until the points below are answered in writing by the appropriate approver (IT security / privacy / your manager).

## 1. What must be approved first
1. That work email metadata (and, for summaries, content) may be processed by an application hosted on a personal Cloudflare account. If the answer is no, stop: Phase 1 stays manual.
2. Whether the Microsoft tenant allows a user-consented or admin-consented app for the permission below, and who registers the app.

## 2. Minimum permissions (delegated, read-only)
| Purpose | Microsoft Graph delegated permission | Notes |
|---|---|---|
| Detect received/sent timestamps, sender/recipient, conversation id | `Mail.ReadBasic` (preferred) | Metadata only: no body, no attachments |
| 5–9-word summaries from content | `Mail.Read` | Only if the organisation explicitly approves body processing |
| Sign in / stay signed in | `User.Read`, `offline_access` | Standard |

**Never requested:** `Mail.Send`, `Mail.ReadWrite`, `MailboxSettings.*`, application-wide (non-delegated) mail permissions. The app must not send, draft, edit, move, delete or mark messages read.

## 3. Data accessed and stored
- Accessed (if approved): Inbox and Sent Items message metadata for messages matching configured project references / known contacts. Message bodies only if `Mail.Read` is approved, held in memory for one summarisation call, never persisted.
- Stored (already in the schema): timestamp (UTC), direction, counterparty email address, optional 5–9-word summary + its basis (`METADATA` or `MANUAL`), reply link, conversation reference, sync cursor/status.
- **Not stored:** bodies, subjects, attachments, passwords, cookies. Tokens are never placed in browser code, `localStorage`, logs, exports or source control.

## 4. Hosting / security implications
- Tokens and the client secret would live only in Cloudflare Worker **secrets** (never in `wrangler.jsonc` or the repo); refresh tokens would need server-side encrypted storage and a revocation path.
- The deployed site is reachable on the public internet; a private GitHub repo does not make it private. Real-data mode would need strong per-user auth (already present), rate limiting, audit logging and a documented retention/deletion policy.
- Sync would be **polling** (e.g. every 5–15 minutes), not real time; the page must show "Last successful sync" and connection state honestly, handle throttling (HTTP 429), expired consent and pagination, and de-duplicate by message id (the `dedupe_key` index already prevents duplicates).
- Conditional Access / Defender / tenant domain restrictions must not be bypassed; if blocked, the connector stays disabled.

## 5. Decision needed from you before Phase 2
Metadata-only (`Mail.ReadBasic`, summaries labelled "metadata-based"/unavailable) or content access (`Mail.Read`, summaries from bodies)?
