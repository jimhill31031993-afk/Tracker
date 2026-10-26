import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import vm from "node:vm";
import { makeD1 } from "./helpers/d1.mjs";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const patched = (await import("../src/index.js")).default;
const original = (await import("./baseline/index.original.js")).default;

const sha = (f) => createHash("sha256").update(readFileSync(join(root, f))).digest("hex");
const baseline = JSON.parse(readFileSync(join(root, "tests/baseline-hashes.json"), "utf8"));

/* ---------- 1. only the intended existing files changed ---------- */
test("every pre-existing file is byte-identical except the 3 declared hook files", () => {
  const allowedChanges = new Set(["src/index.js", "public/common.js", "public/completed.js", "public/completed.html"]);
  const changed = [];
  for (const [file, hash] of Object.entries(baseline)) {
    let now;
    try { now = sha(file); } catch { now = null; }
    if (now !== hash) changed.push(file);
  }
  for (const f of changed) assert.ok(allowedChanges.has(f), `unexpected change to existing file: ${f}`);
  for (const f of ["public/tracker.js", "public/app.js", "public/analytics.js", "public/index.html", "public/style.css", "schema.sql", "schema_update.sql", "wrangler.jsonc"]) {
    assert.ok(!changed.includes(f), f + " must be untouched");
  }
});

test("index.js differs from the original only by the import and the /api/comms/ route", () => {
  const a = readFileSync(join(root, "tests/baseline/index.original.js"), "utf8").split("\n");
  const b = readFileSync(join(root, "src/index.js"), "utf8").split("\n");
  const removed = a.filter((l) => !b.includes(l));
  assert.deepEqual(removed, [], "no original line removed or edited");
  assert.equal(b.length - a.length, 9, "exactly 9 added lines: import(2) + route block(7)");
  assert.ok(b.some((l) => l.includes('import { handleComms } from "./comms.js"')));
  assert.ok(b.some((l) => l.includes('path.startsWith("/api/comms/")')));
  // original lines keep their relative order
  let i = 0;
  for (const l of b) if (i < a.length && l === a[i]) i++;
  assert.equal(i, a.length, "original lines remain in order");
});

test("common.js, completed.js and completed.html changes are purely additive", () => {
  for (const [orig, now] of [["tests/baseline/common.original.js", "public/common.js"], ["tests/baseline/completed.original.js", "public/completed.js"], ["tests/baseline/completed.original.html", "public/completed.html"]]) {
    const a = readFileSync(join(root, orig), "utf8").split("\n");
    const b = readFileSync(join(root, now), "utf8").split("\n");
    assert.deepEqual(a.filter((l) => !b.includes(l)), [], `${now}: no original line removed or edited`);
  }
});

/* ---------- 2. identical API behaviour: run one scenario on both workers ---------- */
function makeEnv(withComms) {
  return { DB: makeD1({ comms: withComms }), ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } };
}

async function scenario(worker, env) {
  const log = [];
  let cookie = "";
  const call = async (method, path, body, auth = true) => {
    const headers = { "Content-Type": "application/json" };
    if (auth && cookie) headers.Cookie = cookie;
    const res = await worker.fetch(new Request("https://t.local" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const sc = res.headers.get("Set-Cookie");
    if (sc && sc.startsWith("session=") && !sc.startsWith("session=;")) cookie = sc.split(";")[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    log.push({ method, path: path.replace(/[0-9a-f-]{36}/g, ":id"), status: res.status, data });
    return data;
  };
  await call("GET", "/api/rows", undefined, false);
  await call("POST", "/api/register", { email: "reg@demo.test", password: "demo-password-1" });
  await call("GET", "/api/me");
  const a = await call("POST", "/api/rows", { address: "DEMO 1 St", wbs: "W1", stage: "Indicative", startDate: "2026-10-01" });
  const b = await call("POST", "/api/rows", { address: "DEMO 2 St", wbs: "W2", stage: "Pricing", startDate: "2026-10-05" });
  await call("POST", "/api/rows", { address: "", wbs: "W3" });
  await call("GET", "/api/rows");
  await call("PATCH", `/api/rows/${a.id}`, { action: "setState", state: "START" });
  await call("PATCH", `/api/rows/${a.id}`, { action: "setState", state: "HOLD" });
  await call("PATCH", `/api/rows/${a.id}`, { action: "setState", state: "START" });
  await call("PATCH", `/api/rows/${a.id}`, { action: "update", address: "DEMO 1 St", wbs: "W1", stage: "Tender", startDate: "2026-10-02", comment: "waiting on site" });
  await call("PATCH", `/api/rows/${a.id}`, { action: "clearComment" });
  await call("PATCH", `/api/rows/${a.id}`, { action: "bogus" });
  await call("PATCH", `/api/rows/${a.id}/close`, { projectValue: 1234.5 });
  await call("PATCH", `/api/rows/${a.id}/close`, { projectValue: -1 });
  await call("GET", "/api/completed");
  await call("PATCH", `/api/completed/${a.id}`, { projectValue: 999 });
  await call("GET", "/api/analytics?scope=month");
  await call("GET", "/api/analytics?scope=year");
  await call("GET", "/api/analytics/stages?months=6");
  await call("DELETE", `/api/rows/${b.id}`);
  await call("DELETE", `/api/rows/${b.id}`);
  await call("GET", "/api/rows");
  await call("POST", "/api/logout");
  await call("GET", "/api/rows", undefined, false);
  await call("POST", "/api/login", { email: "reg@demo.test", password: "wrong-password" }, false);
  await call("GET", "/index.html", undefined, false);
  return log;
}

const normalise = (v) =>
  JSON.parse(
    JSON.stringify(v, (k, val) => {
      if (typeof val === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(val)) return "<id>";
      if (typeof val === "number" && /(At|ts|ClosedAt|stateChangedAt)$/.test(k)) return "<ts>";
      if (k === "ts") return "<ts>";
      // HOLD->START adds real elapsed wall time (milliseconds apart in a test run): compare whole seconds
      if (k === "heldAccumulatedSec" && typeof val === "number") return Math.floor(val);
      return val;
    })
  );

test("existing task CRUD, status changes, close/complete, analytics, auth: identical before/after patch", async () => {
  const before = normalise(await scenario(original, makeEnv(false)));
  const after = normalise(await scenario(patched, makeEnv(true)));
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) assert.deepEqual(after[i], before[i], `step ${i}: ${before[i].method} ${before[i].path}`);
  assert.ok(before.some((s) => s.path === "/api/rows" && s.method === "POST" && s.status === 201), "scenario really exercised task creation");
});

test("patched worker works even if the comms tables were never created", async () => {
  const after = normalise(await scenario(patched, makeEnv(false)));
  const before = normalise(await scenario(original, makeEnv(false)));
  assert.deepEqual(after, before);
});

test("/api/comms/* requires the existing session (401 when signed out)", async () => {
  const env = makeEnv(true);
  for (const [m, p] of [["GET", "/api/comms/overview"], ["GET", "/api/comms/status"], ["POST", "/api/comms/tasks/x/events"], ["PATCH", "/api/comms/settings"]]) {
    const res = await patched.fetch(new Request("https://t.local" + p, { method: m }), env);
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

/* ---------- 3. SLA math + existing reminder code unchanged ---------- */
test("SLA helper functions in common.js are unchanged (loaded and compared)", () => {
  const load = (file) => {
    const ctx = { console, Date, Math, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } }, location: { pathname: "/" } };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(file, "utf8") + "\n;globalThis.__x={computeRemaining,elapsedWorkingSeconds,formatDuration,STAGE_DURATIONS};", ctx);
    return ctx.__x;
  };
  const o = load(join(root, "tests/baseline/common.original.js"));
  const n = load(join(root, "public/common.js"));
  assert.deepEqual(JSON.parse(JSON.stringify(n.STAGE_DURATIONS)), JSON.parse(JSON.stringify(o.STAGE_DURATIONS)));
  const start = new Date(2026, 9, 5, 9).getTime();
  for (const days of [0, 0.5, 1, 3, 4.5, 9, 14, 40]) {
    const end = start + days * 86400e3;
    assert.equal(n.elapsedWorkingSeconds(start, end), o.elapsedWorkingSeconds(start, end), `elapsed ${days}d`);
  }
  const realNow = Date.now;
  try {
    Date.now = () => new Date(2026, 9, 14, 12).getTime();
    for (const stage of ["Indicative", "Detail Design", "Pricing", "Tender", "Not Selected"]) {
      for (const state of ["START", "HOLD", null]) {
        const row = { stage, startDate: "2026-10-05", state, stateChangedAt: new Date(2026, 9, 8).getTime(), heldAccumulatedSec: 7200 };
        assert.deepEqual(JSON.parse(JSON.stringify(n.computeRemaining(row))), JSON.parse(JSON.stringify(o.computeRemaining(row))), `${stage}/${state}`);
      }
    }
  } finally { Date.now = realNow; }
});

test("existing 20%-remaining reminder (tracker.js) is untouched and uses its own storage key", () => {
  const src = readFileSync(join(root, "public/tracker.js"), "utf8");
  assert.equal(sha("public/tracker.js"), baseline["public/tracker.js"]);
  assert.match(src, /siteControlReminderLog_v1/);
  const comms = readFileSync(join(root, "public/comms.js"), "utf8");
  assert.ok(!comms.includes("siteControlReminderLog_v1"), "new reminders never share the old reminder log");
});
