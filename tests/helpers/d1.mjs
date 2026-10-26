// Test-only: a Cloudflare D1-compatible shim backed by real SQLite (node:sqlite),
// loaded with the project's REAL schema files — so SQL is executed, not mocked.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function makeD1({ comms = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(root, "schema.sql"), "utf8"));
  if (comms) db.exec(readFileSync(join(root, "schema_comms.sql"), "utf8"));
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => st.get(...args) ?? null,
            all: async () => ({ results: st.all(...args) }),
            run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
          };
        },
      };
    },
  };
}

export function insertUser(d1, id, email = id + "@demo.test") {
  d1.raw.prepare("INSERT INTO users (id,email,password_hash,salt,created_at) VALUES (?,?,?,?,?)").run(id, email, "x", "y", 1);
}

export function insertRow(d1, { id, userId, no = 1, address = "DEMO 1 Test Street", wbs = "WBS-DEMO", stage = "Indicative", status = "ACTIVE" }) {
  d1.raw
    .prepare(
      `INSERT INTO rows (id,user_id,no,address,wbs,stage,start_date,state,state_changed_at,held_accumulated_sec,comment,history,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(id, userId, no, address, wbs, stage, "2026-10-01", null, 1, 0, "", "[]", status, 1);
}

export function req(method, path, body) {
  return new Request("https://test.local" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
