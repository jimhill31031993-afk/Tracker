import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const L = require("../public/comms-logic.js");
const X = require("../public/xlsx-writer.js");

const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const H = 3600e3;
const events = [
  { id: "in1", rowId: "r1", direction: "IN", occurredAt: T0, address: "cust@demo.test" },
  { id: "out1", rowId: "r1", direction: "OUT", occurredAt: T0 + 2 * H + 14 * 60e3, address: "cust@demo.test", replyToId: "in1", summary: "Reply confirms access for Friday morning", summaryBasis: "MANUAL" },
  { id: "in2", rowId: "r1", direction: "IN", occurredAt: T0 + 5 * H, address: "o'brien+x@demo.test" },
];
const task = { id: "r1", status: "ACTIVE", address: "DEMO <12> & \"Queen\" St", wbs: "W-1", counterpartyType: "CUSTOMER", counterpartyName: "DEMO Customer A" };

const spec = (exp) => L.exportWorkbookSpec(exp);

function dump(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
  const p = join(dir, "t.xlsx");
  writeFileSync(p, bytes);
  return { path: p, data: JSON.parse(execFileSync("python3", [new URL("./helpers/check_xlsx.py", import.meta.url).pathname, p], { encoding: "utf8" })) };
}

test("xlsx opens in openpyxl; CRCs valid; real OOXML parts present", () => {
  const exp = L.buildExport({ task, events, tz: "Pacific/Auckland", now: T0 + 30 * H });
  const bytes = X.build(spec(exp));
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const { data } = dump(bytes);
  assert.equal(data.zip_bad_member, null);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
    assert.ok(data.parts.includes(part), part);
  }
  assert.deepEqual(Object.keys(data.sheets), ["Communication history", "Task info"]);
});

test("xlsx content: headers, real date cells, durations, summaries, labels", () => {
  const exp = L.buildExport({ task, events, tz: "Pacific/Auckland", now: T0 + 30 * H });
  const { data } = dump(X.build(spec(exp)));
  const sheet = data.sheets["Communication history"];
  const header = sheet.rows[0].map((c) => c.v);
  assert.equal(header[0], "Date & time");
  assert.ok(header.includes("Response duration") && header.includes("Summary (5–9 words)"));
  assert.equal(sheet.rows.length, 4, "header + 3 events");
  const first = sheet.rows[1];
  assert.match(first[0].fmt, /yyyy/);
  assert.match(String(first[0].v), /^2026-10-20T13:00:00/, "stored as a real date: 2026-10-20 00:00 UTC = 13:00 NZDT");
  assert.equal(first[5].v, "2h 14m");
  assert.match(first[7].v, /Unavailable/);
  assert.equal(sheet.rows[2][7].v, "Reply confirms access for Friday morning");
  assert.match(sheet.rows[3][5].v, /^Awaiting reply — 25h 0m/);
  assert.equal(sheet.rows[3][4].v, "o'brien+x@demo.test");
  assert.ok(sheet.rows.slice(1).every((r) => /not verified/.test(r[10].v)));
  assert.equal(sheet.freeze, "A2");
  const info = Object.fromEntries(data.sheets["Task info"].rows.map((r) => [r[0].v, r[1].v]));
  assert.equal(info["Project / task"], 'DEMO <12> & "Queen" St', "XML special characters survive");
  assert.match(info["Mode"], /not connected|NOT verified/);
});

test("xlsx handles empty history, unicode, formula-like text and illegal XML chars", () => {
  const exp = L.buildExport({ task, events: [], tz: "UTC", now: T0 });
  assert.equal(dump(X.build(spec(exp))).data.sheets["Communication history"].rows.length, 1);

  const nasty = [
    { id: "n1", rowId: "r1", direction: "IN", occurredAt: T0, address: "=cmd|' /C calc'!A0@demo.test", summary: "Ünïcödé 日本語 summary words go here ok", summaryBasis: "MANUAL" },
    { id: "n2", rowId: "r1", direction: "IN", occurredAt: T0 + H, address: "bad\u0000char\u0007@demo.test" },
  ];
  const e2 = L.buildExport({ task, events: nasty, tz: "UTC", now: T0 + 2 * H });
  const { data } = dump(X.build(spec(e2)));
  const rows = data.sheets["Communication history"].rows;
  assert.equal(rows[1][4].t, "s", "formula-looking text is stored as a string, not a formula");
  assert.equal(rows[1][4].v, "=cmd|' /C calc'!A0@demo.test");
  assert.match(rows[1][7].v, /日本語/);
  assert.equal(rows[2][4].v, "badchar@demo.test");
});

test("export file names are safe and flag demo data", () => {
  const n = L.exportFileName({ wbs: "WBS/014 ..", address: "x" }, T0, "UTC", false);
  assert.equal(n, "communication-history_WBS_014_2026-10-20.xlsx");
  assert.ok(L.exportFileName({ wbs: "W1" }, T0, "UTC", true).startsWith("DEMO_"));
});

test("sheet names are sanitised and unique; CRC32 matches known vector", () => {
  assert.equal(X.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const bytes = X.build({ sheets: [{ name: "a/b:c*?", kv: [["x", "1"]] }, { name: "a/b:c*?", kv: [["y", "2"]] }] });
  assert.equal(Object.keys(dump(bytes).data.sheets).length, 2);
});
