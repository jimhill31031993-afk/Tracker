import test from "node:test";
import assert from "node:assert/strict";
import { handleComms, CONNECTOR_STATUS } from "../src/comms.js";
import { makeD1, insertUser, insertRow, req } from "./helpers/d1.mjs";

const NOW = Date.UTC(2026, 9, 26, 2, 0, 0);
const H = 3600e3;
const deps = { now: () => NOW };

function setup() {
  const d1 = makeD1();
  insertUser(d1, "uA");
  insertUser(d1, "uB");
  insertRow(d1, { id: "rA1", userId: "uA", no: 1, address: "DEMO 1 Alpha St", wbs: "W-A1" });
  insertRow(d1, { id: "rA2", userId: "uA", no: 2, address: "DEMO 2 Beta St", wbs: "W-A2" });
  insertRow(d1, { id: "rAdone", userId: "uA", no: 3, address: "DEMO 3 Done St", wbs: "W-A3", status: "COMPLETED" });
  insertRow(d1, { id: "rB1", userId: "uB", no: 1, address: "DEMO B Other St", wbs: "W-B1" });
  return { env: { DB: d1 }, d1 };
}
const call = async (env, user, method, path, body) => {
  const url = new URL("https://test.local" + path);
  const res = await handleComms(req(method, path, body), env, url, { id: user, email: user + "@demo.test" }, deps);
  return { status: res.status, body: await res.json() };
};
const ev = (extra = {}) => ({ direction: "IN", occurredAt: NOW - 30 * H, address: "cust@demo.test", tz: "Pacific/Auckland", ...extra });

test("status is Demo/Disconnected and cannot be enabled", async () => {
  const { env } = setup();
  const r = await call(env, "uA", "GET", "/api/comms/status");
  assert.equal(r.body.mode, "DEMO_DISCONNECTED");
  assert.equal(r.body.connected, false);
  assert.equal(r.body.lastSync, null);
  assert.match(r.body.message, /not connected/i);
  assert.equal(Object.isFrozen(CONNECTOR_STATUS), true);
});

test("overview reuses live `rows` (active only) and invents nothing", async () => {
  const { env, d1 } = setup();
  const r = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map((t) => t.id), ["rA1", "rA2"], "active tasks from rows; completed excluded");
  assert.deepEqual(r.body.events, [], "empty state: no events invented");
  assert.equal(r.body.mode, "DEMO_DISCONNECTED");
  // a task created in the existing tracker appears immediately — no second register
  insertRow(d1, { id: "rA9", userId: "uA", no: 9, address: "DEMO 9 New St", wbs: "W-A9" });
  const r2 = await call(env, "uA", "GET", "/api/comms/overview");
  assert.ok(r2.body.tasks.some((t) => t.id === "rA9"));
  const tables = d1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name).sort();
  assert.deepEqual(tables, ["comm_events", "comm_reminder_state", "comm_settings", "comm_task_meta", "rows", "sessions", "users"]);
});

test("counterparty: validated, stored as metadata, tracking start kept", async () => {
  const { env } = setup();
  assert.equal((await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "BOGUS", name: "x" })).status, 400);
  assert.equal((await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "CUSTOMER", name: "  " })).status, 400);
  const ok = await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "CUSTOMER", name: "DEMO Customer A" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.trackingStart, NOW);
  const again = await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "VECTOR_TEAM", name: "DEMO Vector" });
  assert.equal(again.body.trackingStart, NOW, "start not reset by editing");
  const bad = await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "CUSTOMER", name: "x", trackingStart: NOW + 10 * H });
  assert.equal(bad.status, 400);
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  const t = ov.body.tasks.find((x) => x.id === "rA1");
  assert.equal(t.counterpartyType, "VECTOR_TEAM");
});

test("event creation: validation, manual/unverified labelling, no future dates", async () => {
  const { env } = setup();
  const p = "/api/comms/tasks/rA1/events";
  assert.equal((await call(env, "uA", "POST", p, ev({ direction: "X" }))).status, 400);
  assert.equal((await call(env, "uA", "POST", p, ev({ address: "not-an-email" }))).status, 400);
  assert.equal((await call(env, "uA", "POST", p, ev({ occurredAt: NOW + 3600e3 }))).status, 400);
  assert.equal((await call(env, "uA", "POST", p, ev({ tz: "Mars/Olympus" }))).status, 400);
  assert.equal((await call(env, "uA", "POST", p, ev({ summary: "too short" }))).status, 400);
  assert.equal((await call(env, "uA", "POST", p, ev({ summary: "this summary is far too long to be accepted here" }))).status, 400);
  const okSum = await call(env, "uA", "POST", p, ev({ summary: "Customer asks for revised drawing set" }));
  assert.equal(okSum.status, 201);
  assert.equal(okSum.body.summaryBasis, "MANUAL");
  assert.equal(okSum.body.verified, false);
  assert.equal(okSum.body.source, "MANUAL");
  const noSum = await call(env, "uA", "POST", p, ev({ occurredAt: NOW - 20 * H }));
  assert.equal(noSum.body.summary, null);
  assert.equal(noSum.body.summaryBasis, "UNAVAILABLE");
  assert.equal((await call(env, "uA", "POST", "/api/comms/tasks/rAdone/events", ev())).status, 400, "completed tasks are read-only");
});

test("duplicate events are prevented", async () => {
  const { env } = setup();
  const p = "/api/comms/tasks/rA1/events";
  assert.equal((await call(env, "uA", "POST", p, ev())).status, 201);
  const dup = await call(env, "uA", "POST", p, ev({ address: "CUST@demo.test" }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "DUPLICATE");
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(ov.body.events.length, 1);
});

test("reply linking: only to an earlier received event on the same task", async () => {
  const { env } = setup();
  const inEv = (await call(env, "uA", "POST", "/api/comms/tasks/rA1/events", ev())).body;
  const other = (await call(env, "uA", "POST", "/api/comms/tasks/rA2/events", ev({ occurredAt: NOW - 10 * H }))).body;
  const post = (body) => call(env, "uA", "POST", "/api/comms/tasks/rA1/events", body);
  assert.equal((await post(ev({ direction: "OUT", occurredAt: NOW - 28 * H, replyToId: other.id }))).status, 400, "other task's event");
  assert.equal((await post(ev({ direction: "OUT", occurredAt: NOW - 40 * H, replyToId: inEv.id }))).status, 400, "reply before message");
  assert.equal((await post(ev({ direction: "IN", occurredAt: NOW - 5 * H, replyToId: inEv.id }))).status, 400, "received cannot be a reply");
  const good = await post(ev({ direction: "OUT", occurredAt: NOW - 28 * H, replyToId: inEv.id }));
  assert.equal(good.status, 201);
  assert.equal(good.body.replyToId, inEv.id);
  assert.equal(good.body.verified, false);
});

test("resolving a suggested match: link or 'not a reply'; delete clears links", async () => {
  const { env } = setup();
  const p = "/api/comms/tasks/rA1/events";
  const inEv = (await call(env, "uA", "POST", p, ev())).body;
  const out = (await call(env, "uA", "POST", p, ev({ direction: "OUT", occurredAt: NOW - 20 * H }))).body;
  const linked = await call(env, "uA", "PATCH", `/api/comms/events/${out.id}`, { replyToId: inEv.id });
  assert.equal(linked.body.replyToId, inEv.id);
  const ruled = await call(env, "uA", "PATCH", `/api/comms/events/${out.id}`, { notAReply: true });
  assert.equal(ruled.body.notAReply, true);
  assert.equal(ruled.body.replyToId, null);
  await call(env, "uA", "PATCH", `/api/comms/events/${out.id}`, { replyToId: inEv.id });
  assert.equal((await call(env, "uA", "DELETE", `/api/comms/events/${inEv.id}`)).status, 200);
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(ov.body.events.length, 1);
  assert.equal(ov.body.events[0].replyToId, null);
});

test("history works for ACTIVE and COMPLETED tasks", async () => {
  const { env, d1 } = setup();
  await call(env, "uA", "POST", "/api/comms/tasks/rA1/events", ev());
  // seed history on a task, then complete it through the existing status model
  d1.raw.prepare("UPDATE rows SET status='COMPLETED' WHERE id='rA1'").run();
  const h = await call(env, "uA", "GET", "/api/comms/tasks/rA1/history");
  assert.equal(h.status, 200);
  assert.equal(h.body.task.status, "COMPLETED");
  assert.equal(h.body.events.length, 1, "history stays accessible after completion");
  const done = await call(env, "uA", "GET", "/api/comms/tasks/rAdone/history");
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.events, []);
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  assert.ok(!ov.body.tasks.some((t) => t.id === "rA1"), "completed tasks leave the active list");
  assert.ok(!ov.body.events.some((e) => e.rowId === "rA1"), "and produce no active reminders input");
});

test("USER ISOLATION: user B cannot see or touch user A's data", async () => {
  const { env } = setup();
  const e = (await call(env, "uA", "POST", "/api/comms/tasks/rA1/events", ev())).body;
  await call(env, "uA", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "CUSTOMER", name: "DEMO Customer A" });
  await call(env, "uA", "PATCH", "/api/comms/settings", { remindersPaused: true, timezone: "Pacific/Auckland" });
  await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: `UNANS:${e.id}`, cycle: 1 });

  const ovB = await call(env, "uB", "GET", "/api/comms/overview");
  assert.deepEqual(ovB.body.tasks.map((t) => t.id), ["rB1"]);
  assert.deepEqual(ovB.body.events, []);
  assert.deepEqual(ovB.body.dismissed, {});
  assert.equal(ovB.body.settings.remindersPaused, false);
  assert.equal(ovB.body.settings.timezone, null);

  assert.equal((await call(env, "uB", "GET", "/api/comms/tasks/rA1/history")).status, 404);
  assert.equal((await call(env, "uB", "POST", "/api/comms/tasks/rA1/events", ev({ address: "z@demo.test" }))).status, 404);
  assert.equal((await call(env, "uB", "PATCH", "/api/comms/tasks/rA1/counterparty", { type: "CUSTOMER", name: "hijack" })).status, 404);
  assert.equal((await call(env, "uB", "PATCH", `/api/comms/events/${e.id}`, { notAReply: true })).status, 404);
  assert.equal((await call(env, "uB", "DELETE", `/api/comms/events/${e.id}`)).status, 404);
  const still = await call(env, "uA", "GET", "/api/comms/tasks/rA1/history");
  assert.equal(still.body.events.length, 1);
  assert.equal(still.body.task.counterpartyName, "DEMO Customer A");
});

test("pause persists per user; resume clears closed displays; history keeps collecting", async () => {
  const { env } = setup();
  const e1 = (await call(env, "uA", "POST", "/api/comms/tasks/rA1/events", ev())).body;
  await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: `UNANS:${e1.id}`, cycle: 1 });
  const paused = await call(env, "uA", "PATCH", "/api/comms/settings", { remindersPaused: true });
  assert.equal(paused.body.remindersPaused, true);
  // while paused, new events are still recorded
  const e2 = await call(env, "uA", "POST", "/api/comms/tasks/rA1/events", ev({ occurredAt: NOW - 3 * H, address: "second@demo.test" }));
  assert.equal(e2.status, 201);
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(ov.body.settings.remindersPaused, true, "persisted");
  assert.equal(ov.body.events.length, 2);
  assert.deepEqual(ov.body.dismissed, { [`UNANS:${e1.id}`]: 1 }, "pause alone keeps dismissals");
  await call(env, "uA", "PATCH", "/api/comms/settings", { remindersPaused: false });
  const after = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(after.body.settings.remindersPaused, false);
  assert.deepEqual(after.body.dismissed, {}, "resume re-evaluates everything due");
  assert.equal(after.body.events.length, 2);
});

test("dismiss only ever raises the dismissed cycle and validates input", async () => {
  const { env } = setup();
  const k = "UNANS:abc";
  await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: k, cycle: 3 });
  await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: k, cycle: 1 });
  const ov = await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(ov.body.dismissed[k], 3);
  assert.equal((await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: "../../x", cycle: 1 })).status, 400);
  assert.equal((await call(env, "uA", "POST", "/api/comms/reminders/dismiss", { key: k, cycle: -1 })).status, 400);
  assert.equal((await call(env, "uA", "PATCH", "/api/comms/settings", { timezone: "Nope/Zone" })).status, 400);
});

test("tasks deleted in the existing tracker leave no orphaned communication data", async () => {
  const { env, d1 } = setup();
  await call(env, "uA", "PATCH", "/api/comms/tasks/rA2/counterparty", { type: "CUSTOMER", name: "DEMO Customer A" });
  await call(env, "uA", "POST", "/api/comms/tasks/rA2/events", ev());
  d1.raw.prepare("DELETE FROM rows WHERE id='rA2'").run(); // what the existing DELETE /api/rows/:id does
  await call(env, "uA", "GET", "/api/comms/overview");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) c FROM comm_events").get().c, 0);
  assert.equal(d1.raw.prepare("SELECT COUNT(*) c FROM comm_task_meta").get().c, 0);
});

test("missing migration gives a clear 503, not a crash", async () => {
  const d1 = makeD1({ comms: false });
  insertUser(d1, "uA");
  const r = await call({ DB: d1 }, "uA", "GET", "/api/comms/overview");
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "MIGRATION_REQUIRED");
  assert.match(r.body.error, /schema_comms\.sql/);
});

test("feature flag: COMMS_ENABLED=false switches the module off", async () => {
  const { env } = setup();
  const r = await call({ ...env, COMMS_ENABLED: "false" }, "uA", "GET", "/api/comms/overview");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "DISABLED");
});

test("NO mailbox capability: source scan of everything shipped", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const root = join(dirname(new URL(import.meta.url).pathname), "..");
  const files = ["src/comms.js", "public/comms.js", "public/comms-ui.js", "public/comms-logic.js", "public/comms-demo.js", "public/xlsx-writer.js"];
  const forbidden = [
    /graph\.microsoft\.com/i, /login\.microsoftonline/i, /\bMail\.(Send|ReadWrite|Read)\b/i, /\bsendMail\b/i,
    /\bmailto:/i, /\bimap\b/i, /client_secret/i, /\baccess_token\b/i, /\brefresh_token\b/i, /\bPublicClientApplication\b/,
    /\bcreateDraft\b/i, /document\.cookie/i, /localStorage|sessionStorage/,
  ];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    for (const re of forbidden) assert.ok(!re.test(src), `${f} must not contain ${re}`);
  }
  assert.ok(readdirSync(join(root, "public")).includes("comms.js"));
});
