import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../public/comms-logic.js");

const H = 3600e3, D = 86400e3;
const T0 = Date.UTC(2026, 9, 20, 0, 0, 0); // fixed "now" anchor
const ev = (id, direction, at, extra = {}) => ({ id, rowId: "r1", direction, occurredAt: at, address: "cust@demo.test", ...extra });
const task = (id, extra = {}) => ({ id, status: "ACTIVE", address: "DEMO " + id, wbs: "W-" + id, counterpartyType: "CUSTOMER", counterpartyName: "DEMO Customer A", trackingStart: T0, ...extra });

/* ---------- durations ---------- */
test("duration formats match the specification examples", () => {
  assert.equal(L.formatDuration(2 * 3600 + 14 * 60), "2h 14m");
  assert.equal(L.formatDuration(27 * 3600), "1d 3h");
  assert.equal(L.formatDuration(45 * 60), "45m");
  assert.equal(L.formatDuration(20), "<1m");
  assert.equal(L.formatAwaiting(26 * 3600 + 10 * 60), "Awaiting reply — 26h 10m");
});

/* ---------- summaries ---------- */
test("summary must be 5-9 words", () => {
  assert.equal(L.countWords("Customer confirms site access for Friday"), 6);
  assert.equal(L.validateSummary("one two three four").ok, false);
  assert.equal(L.validateSummary("one two three four five").ok, true);
  assert.equal(L.validateSummary("one two three four five six seven eight nine").ok, true);
  assert.equal(L.validateSummary("one two three four five six seven eight nine ten").ok, false);
  assert.equal(L.validateSummary("a  b   c d — e").words, 5, "dashes/extra spaces are not words");
  assert.equal(L.validateSummary("").ok, false);
});

test("missing summary is labelled unavailable, never invented", () => {
  const s = L.describeSummary({ summary: null, summaryBasis: "UNAVAILABLE" });
  assert.match(s.text, /Unavailable/);
  assert.equal(s.basis, "Unavailable");
  const m = L.describeSummary({ summary: "Customer confirms site access Friday", summaryBasis: "MANUAL" });
  assert.equal(m.basis, "Manual note");
});

/* ---------- time zones / DST ---------- */
test("Auckland wall time converts correctly outside DST changes", () => {
  const r = L.zonedWallToUtc(2026, 9, 26, 12, 0, "Pacific/Auckland"); // NZST +12
  assert.equal(r.ms, Date.UTC(2026, 8, 26, 0, 0, 0));
  assert.equal(r.invalid, false);
  const r2 = L.zonedWallToUtc(2026, 10, 26, 14, 5, "Pacific/Auckland"); // NZDT +13
  assert.equal(r2.ms, Date.UTC(2026, 9, 26, 1, 5, 0));
});

test("spring-forward gap time is rejected, fall-back ambiguity is flagged", () => {
  // NZ DST starts 2026-09-27 02:00 -> 03:00
  const gap = L.zonedWallToUtc(2026, 9, 27, 2, 30, "Pacific/Auckland");
  assert.equal(gap.invalid, true);
  // NZ DST ends 2027-04-04 03:00 -> 02:00 so 02:30 happens twice
  const amb = L.zonedWallToUtc(2027, 4, 4, 2, 30, "Pacific/Auckland");
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.ms, Date.UTC(2027, 3, 3, 13, 30, 0), "earlier (NZDT +13) occurrence");
});

test("24 elapsed hours across a DST change are still 24h of elapsed time", () => {
  const before = L.zonedWallToUtc(2026, 9, 26, 12, 0, "Pacific/Auckland").ms;
  const after = L.zonedWallToUtc(2026, 9, 27, 12, 0, "Pacific/Auckland").ms; // wall clocks 24h apart
  assert.equal(after - before, 23 * H, "only 23 real hours pass across the spring-forward");
  const cfg = { tasks: [task("r1")], events: [ev("e1", "IN", before)] };
  const at24 = L.computeReminders({ ...cfg, now: before + 24 * H });
  const at23 = L.computeReminders({ ...cfg, now: after });
  assert.equal(at24.unanswered.length, 1);
  assert.equal(at23.unanswered.length, 0, "wall-clock 'tomorrow' (23 real hours) is not yet 24 hours");
});

test("formatting and parsing round-trip in the user's zone", () => {
  const ms = L.parseLocalInput("2026-10-26T14:05", "Pacific/Auckland").ms;
  assert.equal(L.toLocalInputValue(ms, "Pacific/Auckland"), "2026-10-26T14:05");
  assert.match(L.formatDateTime(ms, "Pacific/Auckland"), /^2026-10-26 14:05 /);
  assert.notEqual(L.formatDateTime(ms, "UTC"), L.formatDateTime(ms, "Pacific/Auckland"));
  assert.equal(L.parseLocalInput("2026-02-30T10:00", "UTC").invalid, true);
  assert.equal(L.isValidTimeZone("Not/AZone"), false);
});

/* ---------- ordering + matching ---------- */
test("events sort chronologically, IN before OUT on equal timestamps", () => {
  const sorted = L.sortEvents([ev("b", "OUT", 100), ev("a", "IN", 100), ev("c", "IN", 50)], "asc").map((e) => e.id);
  assert.deepEqual(sorted, ["c", "a", "b"]);
  assert.deepEqual(L.sortEvents([ev("b", "OUT", 100), ev("c", "IN", 50)], "desc").map((e) => e.id), ["b", "c"]);
});

test("explicitly linked reply pairs and computes response duration", () => {
  const events = [ev("in1", "IN", T0), ev("out1", "OUT", T0 + 2 * H + 14 * 60e3, { replyToId: "in1" })];
  const a = L.analyseEvents(events);
  assert.equal(a.get("in1").status, "MATCHED");
  assert.equal(a.get("out1").durationSec, 2 * 3600 + 14 * 60);
  assert.equal(L.formatDuration(a.get("in1").durationSec), "2h 14m");
});

test("same thread reference pairs reliably", () => {
  const events = [ev("in1", "IN", T0, { threadRef: "WBS-1" }), ev("out1", "OUT", T0 + H, { threadRef: "wbs-1" })];
  assert.equal(L.analyseEvents(events).get("in1").status, "MATCHED");
});

test("uncertain match is NOT paired: flagged for manual review", () => {
  const events = [ev("in1", "IN", T0), ev("out1", "OUT", T0 + H)]; // same address, no link
  const a = L.analyseEvents(events);
  assert.equal(a.get("out1").status, "REVIEW");
  assert.deepEqual(a.get("out1").candidates, ["in1"]);
  assert.equal(a.get("in1").status, "REVIEW");
  assert.equal(a.get("in1").durationSec, null, "no invented duration");
});

test("a sent message to someone else is standalone, not a reply", () => {
  const events = [ev("in1", "IN", T0), ev("out1", "OUT", T0 + H, { address: "other@demo.test" })];
  const a = L.analyseEvents(events);
  assert.equal(a.get("out1").status, "STANDALONE");
  assert.equal(a.get("in1").status, "AWAITING");
});

test("'not a reply' resolves a suggested match without pairing", () => {
  const events = [ev("in1", "IN", T0), ev("out1", "OUT", T0 + H, { notAReply: true })];
  const a = L.analyseEvents(events);
  assert.equal(a.get("out1").status, "STANDALONE");
  assert.equal(a.get("in1").status, "AWAITING");
});

test("a reply dated before the message is never paired", () => {
  const events = [ev("in1", "IN", T0 + H), ev("out1", "OUT", T0, { replyToId: "in1" })];
  assert.notEqual(L.analyseEvents(events).get("in1").status, "MATCHED");
});

/* ---------- 24h unanswered reminder ---------- */
test("unanswered reminder starts at 24h and repeats every 24h", () => {
  const base = { tasks: [task("r1")], events: [ev("in1", "IN", T0)], dismissed: {}, paused: false };
  assert.equal(L.computeReminders({ ...base, now: T0 + 24 * H - 1 }).unanswered.length, 0);
  const r1 = L.computeReminders({ ...base, now: T0 + 24 * H });
  assert.equal(r1.unanswered[0].cycle, 1);
  assert.equal(L.computeReminders({ ...base, now: T0 + 47 * H }).unanswered[0].cycle, 1);
  assert.equal(L.computeReminders({ ...base, now: T0 + 48 * H }).unanswered[0].cycle, 2);
  assert.equal(L.computeReminders({ ...base, now: T0 + 72 * H }).unanswered[0].cycle, 3);
});

test("closing a popup dismisses that display only; next cycle shows again", () => {
  const base = { tasks: [task("r1")], events: [ev("in1", "IN", T0)], paused: false };
  const now1 = T0 + 25 * H;
  assert.equal(L.computeReminders({ ...base, now: now1, dismissed: {} }).popups.length, 1);
  const dismissed = { "UNANS:in1": 1 };
  const same = L.computeReminders({ ...base, now: now1, dismissed });
  assert.equal(same.popups.length, 0, "this display closed");
  assert.equal(same.unanswered.length, 1, "event and reminder still exist (reminder centre)");
  const later = L.computeReminders({ ...base, now: T0 + 49 * H, dismissed });
  assert.equal(later.popups.length, 1, "24h later it returns");
});

test("a linked sent reply clears the unanswered reminder; a status change does not", () => {
  const tasks = [task("r1")];
  const unanswered = [ev("in1", "IN", T0)];
  const now = T0 + 30 * H;
  assert.equal(L.computeReminders({ tasks, events: unanswered, now }).unanswered.length, 1);
  // task status/stage changes alone do not clear it
  assert.equal(L.computeReminders({ tasks: [task("r1", { stage: "Pricing", state: "HOLD" })], events: unanswered, now }).unanswered.length, 1);
  const withReply = [...unanswered, ev("out1", "OUT", T0 + 5 * H, { replyToId: "in1" })];
  assert.equal(L.computeReminders({ tasks, events: withReply, now }).unanswered.length, 0);
  // an unlinked sent message to the same address does NOT clear it (needs review)
  const unlinked = [...unanswered, ev("out2", "OUT", T0 + 5 * H)];
  const r = L.computeReminders({ tasks, events: unlinked, now });
  assert.equal(r.unanswered.length, 1);
  assert.equal(r.unanswered[0].needsReview, true);
});

/* ---------- weekly reminder ---------- */
test("weekly reminder appears at day 6 after the last sent message, not before", () => {
  const events = [ev("out1", "OUT", T0, { rowId: "r1", address: "cust@demo.test" })];
  const base = { tasks: [task("r1")], events, dismissed: {}, paused: false };
  assert.equal(L.computeReminders({ ...base, now: T0 + 6 * D - 1 }).weekly.length, 0);
  const due = L.computeReminders({ ...base, now: T0 + 6 * D });
  assert.equal(due.weekly.length, 1);
  assert.equal(due.weekly[0].basis, "LAST_SENT");
  assert.equal(due.weekly[0].overLimit, false);
  assert.equal(L.computeReminders({ ...base, now: T0 + 7 * D }).weekly[0].overLimit, true);
});

test("weekly: no outgoing history counts from tracking start and says so", () => {
  const r = L.computeReminders({ tasks: [task("r1", { trackingStart: T0 })], events: [], now: T0 + 6 * D });
  assert.equal(r.weekly[0].basis, "TRACKING_START");
  assert.equal(r.weekly[0].anchor, T0);
});

test("weekly reminders group by counterparty: one per group, not per task", () => {
  const tasks = [
    task("r1"), task("r2"), task("r3"),
    task("r4", { counterpartyType: "VECTOR_TEAM", counterpartyName: "DEMO Vector Team" }),
    task("r5", { counterpartyType: "CUSTOMER", counterpartyName: "DEMO Customer B" }),
  ];
  const r = L.computeReminders({ tasks, events: [], now: T0 + 6 * D });
  assert.equal(r.weekly.length, 3, "3 groups, 5 tasks");
  const a = r.weekly.find((w) => w.groupName === "DEMO Customer A");
  assert.deepEqual(a.tasks.map((t) => t.id).sort(), ["r1", "r2", "r3"]);
  assert.ok(!r.weekly.some((w) => w.tasks.some((t) => t.id === "r4") && w.groupType !== "VECTOR_TEAM"), "different counterparties are never combined");
});

test("one sent message on any task in the group resets the whole group", () => {
  const tasks = [task("r1"), task("r2")];
  const events = [ev("o1", "OUT", T0 + 5 * D, { rowId: "r2" })];
  const r = L.computeReminders({ tasks, events, now: T0 + 6 * D });
  assert.equal(r.weekly.length, 0);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].due, false);
});

test("weekly: one pop-up per due cycle, not duplicated for the same cycle", () => {
  const base = { tasks: [task("r1"), task("r2")], events: [], paused: false };
  const k = "WEEKLY:" + L.groupKey("CUSTOMER", "DEMO Customer A");
  const day6 = T0 + 6 * D + H;
  const first = L.computeReminders({ ...base, now: day6, dismissed: {} });
  assert.equal(first.popups.length, 1);
  const closed = L.computeReminders({ ...base, now: day6 + 5 * H, dismissed: { [k]: first.weekly[0].cycle } });
  assert.equal(closed.popups.length, 0);
  const nextDay = L.computeReminders({ ...base, now: T0 + 7 * D + 2 * H, dismissed: { [k]: first.weekly[0].cycle } });
  assert.equal(nextDay.popups.length, 1, "dismissal does not suppress future cycles");
});

test("completed tasks never produce reminders", () => {
  const tasks = [task("r1", { status: "COMPLETED" })];
  const r = L.computeReminders({ tasks, events: [ev("in1", "IN", T0)], now: T0 + 10 * D });
  assert.equal(r.unanswered.length, 0);
  assert.equal(r.weekly.length, 0);
  assert.equal(r.groups.length, 0);
});

test("tasks with no counterparty get unanswered reminders but no weekly group", () => {
  const tasks = [task("r1", { counterpartyType: null, counterpartyName: null, trackingStart: null })];
  const r = L.computeReminders({ tasks, events: [ev("in1", "IN", T0)], now: T0 + 30 * H });
  assert.equal(r.unanswered.length, 1);
  assert.equal(r.weekly.length, 0);
});

/* ---------- pause / resume ---------- */
test("pause turns off pop-ups only; due calculations continue", () => {
  const base = { tasks: [task("r1")], events: [ev("in1", "IN", T0)], dismissed: {}, now: T0 + 30 * H };
  const running = L.computeReminders({ ...base, paused: false });
  const paused = L.computeReminders({ ...base, paused: true });
  assert.equal(running.popups.length, 1);
  assert.equal(paused.popups.length, 0);
  assert.equal(paused.unanswered.length, running.unanswered.length, "still tracked and due");
  assert.equal(paused.weekly.length, running.weekly.length);
  assert.equal(paused.unanswered[0].elapsedMs, running.unanswered[0].elapsedMs);
  // while paused, time keeps passing; on resume the overdue item is recalculated
  const resumed = L.computeReminders({ ...base, now: T0 + 80 * H, paused: false });
  assert.equal(resumed.popups.length, 1);
  assert.equal(resumed.unanswered[0].cycle, 3);
});

/* ---------- export model ---------- */
test("export rows: labelled manual/unverified, summary unavailable, duration honest", () => {
  const events = [
    ev("in1", "IN", T0),
    ev("out1", "OUT", T0 + 2 * H, { replyToId: "in1", summary: "Reply confirms access for Friday morning", summaryBasis: "MANUAL" }),
    ev("in2", "IN", T0 + 3 * H),
  ];
  const t = { ...task("r1"), status: "ACTIVE" };
  const x = L.buildExport({ task: t, events, tz: "Pacific/Auckland", now: T0 + 30 * H, demo: false });
  assert.equal(x.rows.length, 3);
  assert.equal(x.header.length, x.rows[0] ? Object.keys(x.rows[0]).length : 11);
  assert.ok(x.rows.every((r) => /not verified/.test(r.source)));
  assert.equal(x.rows[0].duration, "2h 0m");
  assert.match(x.rows[2].duration, /^Awaiting reply — 27h 0m/);
  assert.match(x.rows[0].summary, /Unavailable/);
  assert.equal(x.rows[1].summaryBasis, "Manual note");
  const completed = L.buildExport({ task: { ...t, status: "COMPLETED" }, events, tz: "UTC", now: T0 + 30 * H });
  assert.equal(completed.rows[2].duration, "No reply recorded");
  const demo = L.buildExport({ task: t, events, tz: "UTC", now: T0, demo: true });
  assert.ok(demo.rows.every((r) => /DEMO/.test(r.source)));
});
