// Test-only dev harness: runs the REAL Worker code (src/index.js) against an in-memory SQLite
// database (real schema + schema_comms.sql) and serves ./public as the static assets.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../src/index.js";
import { makeD1 } from "../helpers/d1.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pub = join(root, "public");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const env = {
  DB: makeD1({ comms: process.env.NO_COMMS_TABLES ? false : true }),
  ASSETS: {
    fetch: async (req) => {
      let p = new URL(req.url).pathname;
      if (p === "/") p = "/index.html";
      const f = join(pub, p);
      if (!f.startsWith(pub) || !existsSync(f) || !statSync(f).isFile()) return new Response("nf", { status: 404 });
      return new Response(readFileSync(f), { headers: { "Content-Type": types[extname(f)] || "application/octet-stream" } });
    },
  },
};
const server = http
  .createServer(async (nreq, nres) => {
    const chunks = [];
    for await (const c of nreq) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const req = new Request("http://localhost:" + server.address().port + nreq.url, {
      method: nreq.method,
      headers: nreq.headers,
      body: ["GET", "HEAD"].includes(nreq.method) ? undefined : body,
    });
    const res = await worker.fetch(req, env);
    const h = {};
    res.headers.forEach((v, k) => (h[k] = v));
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) h["set-cookie"] = sc;
    nres.writeHead(res.status, h);
    nres.end(Buffer.from(await res.arrayBuffer()));
  })
  .listen(0, () => console.log("PORT=" + server.address().port));

