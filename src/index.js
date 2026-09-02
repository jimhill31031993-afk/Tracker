// src/index.js
// One Worker script: auth (register/login/logout/me), the tracker's
// row CRUD + close-to-completed flow, the completed list, analytics,
// and serving the static site from ./public.

const STAGE_DURATIONS = {
  "Not Selected": 0,
  "Indicative": 5,
  "Detail Design": 20,
  "Pricing": 2,
  "Handover": 3,
  "Redesign": 5,
  "Repricing": 2,
  "ECI": 10,
  "Tender": 10,
};

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/register" && request.method === "POST") return await handleRegister(request, env);
      if (path === "/api/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/api/logout" && request.method === "POST") return await handleLogout(request, env);
      if (path === "/api/me" && request.method === "GET") return await handleMe(request, env);

      if (path === "/api/rows") {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        if (request.method === "GET") return await listActiveRows(user, env);
        if (request.method === "POST") return await createRow(user, request, env);
      }

      let m = path.match(/^\/api\/rows\/([^/]+)\/close$/);
      if (m) {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        if (request.method === "PATCH") return await closeRow(user, m[1], request, env);
      }

      m = path.match(/^\/api\/rows\/([^/]+)$/);
      if (m) {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        if (request.method === "PATCH") return await updateRow(user, m[1], request, env);
        if (request.method === "DELETE") return await deleteRow(user, m[1], env);
      }

      if (path === "/api/completed" && request.method === "GET") {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        return await listCompletedRows(user, env);
      }

      m = path.match(/^\/api\/completed\/([^/]+)$/);
      if (m && request.method === "PATCH") {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        return await updateCompletedValue(user, m[1], request, env);
      }

      if (path === "/api/analytics" && request.method === "GET") {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        return await getAnalytics(user, url, env);
      }

      if (path === "/api/analytics/stages" && request.method === "GET") {
        const user = await requireAuth(request, env);
        if (!user) return unauthorized();
        return await getStageAnalytics(user, url, env);
      }
    } catch (err) {
      return json({ error: "Server error: " + err.message }, 500);
    }

    return env.ASSETS.fetch(request);
  },
};

/* ===========================================================
   Auth
   =========================================================== */
async function handleRegister(request, env) {
  const body = await safeJson(request);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "That email is already registered" }, 400);

  const id = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);
  const now = Date.now();

  await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, hash, salt, now)
    .run();

  return startSession(id, email, env);
}

async function handleLogin(request, env) {
  const body = await safeJson(request);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user) return json({ error: "Invalid email or password" }, 401);

  const ok = await verifyPassword(password, user.salt, user.password_hash);
  if (!ok) return json({ error: "Invalid email or password" }, 401);

  return startSession(user.id, user.email, env);
}

async function handleLogout(request, env) {
  const token = getCookie(request, "session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearCookieHeader() },
  });
}

async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return unauthorized();
  return json({ id: user.id, email: user.email });
}

async function startSession(userId, email, env) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, now, now + SESSION_MAX_AGE * 1000)
    .run();

  return new Response(JSON.stringify({ id: userId, email }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token, SESSION_MAX_AGE) },
  });
}

async function requireAuth(request, env) {
  return getSessionUser(request, env);
}

async function getSessionUser(request, env) {
  const token = getCookie(request, "session");
  if (!token) return null;
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE token = ?").bind(token).first();
  if (!session || session.expires_at < Date.now()) return null;
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(session.user_id).first();
  return user || null;
}

/* ===========================================================
   Rows — Tracker (active)
   =========================================================== */
async function listActiveRows(user, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rows WHERE user_id = ? AND status = 'ACTIVE' ORDER BY no ASC"
  )
    .bind(user.id)
    .all();
  return json(results.map(rowFromDb));
}

async function createRow(user, request, env) {
  const body = await safeJson(request);
  const { address, wbs, stage, startDate } = body;
  if (!address || !wbs || !stage || !startDate) {
    return json({ error: "address, wbs, stage and startDate are all required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  const maxNoRow = await env.DB.prepare("SELECT MAX(no) AS maxNo FROM rows WHERE user_id = ?").bind(user.id).first();
  const no = (maxNoRow && maxNoRow.maxNo ? maxNoRow.maxNo : 0) + 1;

  const history = [{ type: "CREATED", ts: now, detail: `Project logged — stage: ${stage}` }];

  await env.DB.prepare(
    `INSERT INTO rows
       (id, user_id, no, address, wbs, stage, start_date, state, state_changed_at, held_accumulated_sec, comment, history, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`
  )
    .bind(id, user.id, no, address, wbs, stage, startDate, null, now, 0, "", JSON.stringify(history), now)
    .run();

  const row = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(row), 201);
}

async function updateRow(user, id, request, env) {
  const body = await safeJson(request);
  const existing = await env.DB.prepare("SELECT * FROM rows WHERE id = ? AND user_id = ? AND status = 'ACTIVE'")
    .bind(id, user.id)
    .first();
  if (!existing) return json({ error: "Row not found" }, 404);

  const history = JSON.parse(existing.history || "[]");
  const now = Date.now();

  if (body.action === "setState") {
    const newState = body.state === "HOLD" ? "HOLD" : "START";
    if (existing.state !== newState) {
      let heldAcc = existing.held_accumulated_sec || 0;
      if (existing.state === "HOLD" && newState === "START") {
        heldAcc += elapsedWorkingSeconds(existing.state_changed_at, now);
      }
      history.push({ type: newState, ts: now, detail: newState === "START" ? "Countdown started/resumed" : "Countdown held" });
      await env.DB.prepare(
        `UPDATE rows SET state = ?, state_changed_at = ?, held_accumulated_sec = ?, history = ? WHERE id = ?`
      )
        .bind(newState, now, heldAcc, JSON.stringify(history), id)
        .run();
    }
  } else if (body.action === "update") {
    const { address, wbs, stage, startDate, comment } = body;
    if (comment !== existing.comment) {
      history.push({ type: "COMMENT", ts: now, detail: comment ? comment : "(comment cleared)" });
    }
    await env.DB.prepare(
      `UPDATE rows SET address = ?, wbs = ?, stage = ?, start_date = ?, comment = ?, history = ? WHERE id = ?`
    )
      .bind(address, wbs, stage, startDate, comment ?? "", JSON.stringify(history), id)
      .run();
  } else if (body.action === "clearComment") {
    if (existing.comment) {
      history.push({ type: "CLEAR", ts: now, detail: `Cleared: "${existing.comment}"` });
      await env.DB.prepare(`UPDATE rows SET comment = '', history = ? WHERE id = ?`).bind(JSON.stringify(history), id).run();
    }
  } else {
    return json({ error: "Unknown action" }, 400);
  }

  const updated = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(updated));
}

async function deleteRow(user, id, env) {
  const result = await env.DB.prepare("DELETE FROM rows WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "Row not found" }, 404);
  return json({ ok: true });
}

/* ===========================================================
   Close a row -> moves it to Completed
   =========================================================== */
async function closeRow(user, id, request, env) {
  const body = await safeJson(request);
  const projectValue = Number(body.projectValue);
  if (!Number.isFinite(projectValue) || projectValue < 0) {
    return json({ error: "Enter a valid project value" }, 400);
  }

  const existing = await env.DB.prepare("SELECT * FROM rows WHERE id = ? AND user_id = ? AND status = 'ACTIVE'")
    .bind(id, user.id)
    .first();
  if (!existing) return json({ error: "Row not found" }, 404);

  const now = Date.now();
  const allocDays = STAGE_DURATIONS[existing.stage] ?? 0;
  let onTime = 1;

  if (allocDays > 0 && existing.start_date) {
    const allocSec = allocDays * 86400;
    const startMs = new Date(existing.start_date + "T00:00:00").getTime();
    const endPoint = existing.state === "HOLD" ? existing.state_changed_at : now;
    const gross = elapsedWorkingSeconds(startMs, endPoint);
    const net = Math.max(0, gross - (existing.held_accumulated_sec || 0));
    const remainSec = allocSec - net;
    onTime = remainSec >= 0 ? 1 : 0;
  }

  const history = JSON.parse(existing.history || "[]");
  history.push({ type: "CLOSED", ts: now, detail: `Closed — project value ${projectValue}` });

  await env.DB.prepare(
    `UPDATE rows SET status = 'COMPLETED', project_value = ?, closed_at = ?, on_time = ?, history = ? WHERE id = ?`
  )
    .bind(projectValue, now, onTime, JSON.stringify(history), id)
    .run();

  const updated = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(updated));
}

/* ===========================================================
   Rows — Completed
   =========================================================== */
async function listCompletedRows(user, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rows WHERE user_id = ? AND status = 'COMPLETED' ORDER BY closed_at DESC"
  )
    .bind(user.id)
    .all();
  return json(results.map(rowFromDb));
}

async function updateCompletedValue(user, id, request, env) {
  const body = await safeJson(request);
  const projectValue = Number(body.projectValue);
  if (!Number.isFinite(projectValue) || projectValue < 0) {
    return json({ error: "Enter a valid project value" }, 400);
  }

  const existing = await env.DB.prepare("SELECT * FROM rows WHERE id = ? AND user_id = ? AND status = 'COMPLETED'")
    .bind(id, user.id)
    .first();
  if (!existing) return json({ error: "Row not found" }, 404);

  await env.DB.prepare("UPDATE rows SET project_value = ? WHERE id = ?").bind(projectValue, id).run();
  const updated = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(updated));
}

/* ===========================================================
   Analytics
   =========================================================== */
async function getAnalytics(user, url, env) {
  const now = new Date();
  const scope = url.searchParams.get("scope") === "year" ? "year" : "month";
  const year = parseInt(url.searchParams.get("year")) || now.getUTCFullYear();
  const month = parseInt(url.searchParams.get("month")) || now.getUTCMonth() + 1;

  if (scope === "month") {
    const { results } = await env.DB.prepare(
      `SELECT strftime('%Y-%m', closed_at/1000, 'unixepoch') AS ym,
              SUM(project_value) AS total, COUNT(*) AS cnt, SUM(on_time) AS ontime
       FROM rows WHERE user_id = ? AND status = 'COMPLETED' GROUP BY ym`
    )
      .bind(user.id)
      .all();

    const map = {};
    results.forEach((r) => (map[r.ym] = r));

    const series = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(year, month - 1 - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const entry = map[key];
      series.push({
        label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + " " + d.getUTCFullYear(),
        value: entry ? entry.total || 0 : 0,
      });
    }

    const selKey = `${year}-${String(month).padStart(2, "0")}`;
    const sel = map[selKey] || { total: 0, cnt: 0, ontime: 0 };
    return json({
      scope,
      year,
      month,
      periodLabel: new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      totalValue: sel.total || 0,
      completedCount: sel.cnt || 0,
      onTimePercent: sel.cnt ? Math.round(((sel.ontime || 0) / sel.cnt) * 100) : 0,
      series,
    });
  } else {
    const { results } = await env.DB.prepare(
      `SELECT strftime('%Y', closed_at/1000, 'unixepoch') AS y,
              SUM(project_value) AS total, COUNT(*) AS cnt, SUM(on_time) AS ontime
       FROM rows WHERE user_id = ? AND status = 'COMPLETED' GROUP BY y`
    )
      .bind(user.id)
      .all();

    const map = {};
    results.forEach((r) => (map[r.y] = r));

    const series = [];
    for (let i = 4; i >= 0; i--) {
      const y = year - i;
      const entry = map[String(y)];
      series.push({ label: String(y), value: entry ? entry.total || 0 : 0 });
    }

    const sel = map[String(year)] || { total: 0, cnt: 0, ontime: 0 };
    return json({
      scope,
      year,
      periodLabel: String(year),
      totalValue: sel.total || 0,
      completedCount: sel.cnt || 0,
      onTimePercent: sel.cnt ? Math.round(((sel.ontime || 0) / sel.cnt) * 100) : 0,
      series,
    });
  }
}

async function getStageAnalytics(user, url, env) {
  let months = parseInt(url.searchParams.get("months")) || 12;
  if (![6, 12, 24].includes(months)) months = 12;

  const { results } = await env.DB.prepare(
    `SELECT strftime('%Y-%m', closed_at/1000, 'unixepoch') AS ym, stage,
            COUNT(*) AS cnt, SUM(on_time) AS ontime
     FROM rows WHERE user_id = ? AND status = 'COMPLETED' GROUP BY ym, stage`
  )
    .bind(user.id)
    .all();

  const map = {};
  results.forEach((r) => {
    if (!map[r.stage]) map[r.stage] = {};
    map[r.stage][r.ym] = { cnt: r.cnt, ontime: r.ontime };
  });

  const now = new Date();
  const keys = [];
  const labels = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    labels.push(d.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }));
  }

  const STAGES = ["Indicative", "Detail Design", "Pricing", "Handover", "Redesign", "Repricing", "ECI", "Tender"];

  const pointFor = (stage, key) => {
    const e = (map[stage] || {})[key];
    if (!e || !e.cnt) return null;
    return { cnt: e.cnt, ontime: e.ontime, pct: Math.round((e.ontime / e.cnt) * 100) };
  };

  const series = STAGES.map((stage) => ({
    stage,
    points: keys.map((k) => pointFor(stage, k)),
  }));

  const totalPoints = keys.map((k) => {
    let cnt = 0, ontime = 0;
    STAGES.forEach((stage) => {
      const e = (map[stage] || {})[k];
      if (e) { cnt += e.cnt; ontime += e.ontime; }
    });
    if (!cnt) return null;
    return { cnt, ontime, pct: Math.round((ontime / cnt) * 100) };
  });

  return json({ months, labels, series, total: { points: totalPoints } });
}

/* ===========================================================
   Shared helpers
   =========================================================== */
function elapsedWorkingSeconds(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let curDay = new Date(startMs);
  curDay.setUTCHours(0, 0, 0, 0);

  while (curDay.getTime() <= endMs) {
    const dow = curDay.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const nextDay = new Date(curDay);
      nextDay.setUTCDate(curDay.getUTCDate() + 1);
      const dayStart = Math.max(curDay.getTime(), startMs);
      const dayEnd = Math.min(nextDay.getTime(), endMs);
      if (dayEnd > dayStart) total += (dayEnd - dayStart) / 1000;
    }
    curDay.setUTCDate(curDay.getUTCDate() + 1);
  }
  return total;
}

function rowFromDb(r) {
  return {
    id: r.id,
    no: r.no,
    address: r.address,
    wbs: r.wbs,
    stage: r.stage,
    startDate: r.start_date,
    state: r.state,
    stateChangedAt: r.state_changed_at,
    heldAccumulatedSec: r.held_accumulated_sec,
    comment: r.comment,
    history: JSON.parse(r.history || "[]"),
    status: r.status,
    projectValue: r.project_value,
    closedAt: r.closed_at,
    onTime: r.on_time,
  };
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHashHex;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

function sessionCookieHeader(token, maxAgeSec) {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
function clearCookieHeader() {
  return `session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function unauthorized() {
  return json({ error: "Not signed in" }, 401);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
