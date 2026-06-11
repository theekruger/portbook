// Auth test — when $PORTBOOK_TOKEN is set, the server gates the DATA api (/api/*) behind a bearer
// token while the dashboard shell (GET /) stays public; the fleet client sends the token automatically.
// Also covers the browser-write (CSRF) gate and the request-body size cap on a tokenless server.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

// Never inherit fleet config from the host machine — docs/FLEET.md tells users to export these in
// their shell profile, which used to turn this suite red. Tests set their own values explicitly.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-auth-test-"));
const { createServer } = await import("../src/server.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// Raw HTTP client — used where we must control headers fetch() may own (Origin) or stream a body.
const req = (base, { method = "GET", path: p = "/", headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const rq = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (rs) => {
    let b = ""; rs.on("data", (d) => (b += d)); rs.on("end", () => resolve({ status: rs.statusCode, headers: rs.headers, body: b }));
  });
  rq.on("error", reject);
  rq.end(body);
});

// ── Tokenless server (the local default): /api/* is open, but browser-originated writes are CSRF.
const open = createServer(); // PORTBOOK_TOKEN is unset here → open server
await new Promise((r) => open.listen(0, "127.0.0.1", r));
const obase = `http://127.0.0.1:${open.address().port}`;
const ohost = `127.0.0.1:${open.address().port}`;

ok("no-Origin POST (CLI / native fetch) succeeds", (await req(obase, { method: "POST", path: "/api/gc" })).status === 200);
ok("same-origin POST (the dashboard) succeeds", (await req(obase, { method: "POST", path: "/api/gc", headers: { origin: `http://${ohost}` } })).status === 200);
ok("cross-origin POST (a foreign web page) → 403", (await req(obase, { method: "POST", path: "/api/gc", headers: { origin: "http://evil.example" } })).status === 403);
const pre = await req(obase, { method: "OPTIONS", path: "/api/release", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
ok("cross-origin POST preflight is refused (403, no approval)", pre.status === 403 && !pre.headers["access-control-allow-origin"]);
const read = await req(obase, { path: "/api/list", headers: { origin: "http://evil.example" } });
ok("GETs keep permissive CORS (editor/webview reads)", read.status === 200 && read.headers["access-control-allow-origin"] === "*");

// Oversized body must SETTLE with a 413 — the old code req.destroy()ed and the awaiting handler hung
// forever (client saw a bare connection reset, the server leaked the frame + buffered body).
const big = await req(obase, { method: "POST", path: "/api/report", body: "x".repeat((1 << 20) + 16) }).catch(() => ({ status: "reset" }));
ok("oversized request body → 413 (readBody settles)", big.status === 413);
ok("server still answers after the oversized request", (await req(obase, { path: "/api/list" })).status === 200);
open.close();

// ── Token-protected server: /api/* requires the bearer (compared constant-time).
process.env.PORTBOOK_TOKEN = "secret-xyz"; // captured by createServer() at construction
const srv = createServer(); // snapshots PORTBOOK_TOKEN = "secret-xyz"
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

ok("GET /api/* with no token → 401", (await fetch(base + "/api/list")).status === 401);
ok("GET /api/* with a wrong token → 401", (await fetch(base + "/api/list", { headers: { authorization: "Bearer nope" } })).status === 401);
const good = await fetch(base + "/api/list", { headers: { authorization: "Bearer secret-xyz" } });
ok("GET /api/* with the right token → 200", good.status === 200 && Array.isArray(await good.json()));
ok("GET / (dashboard shell) stays public", (await fetch(base + "/")).status === 200);

// A valid bearer also authorizes a cross-origin POST (browsers can't attach it — Authorization isn't
// in Allow-Headers — so this only opens the door for deliberate non-browser callers).
ok("cross-origin POST with the right token succeeds", (await req(base, { method: "POST", path: "/api/gc", headers: { origin: "http://evil.example", authorization: "Bearer secret-xyz" } })).status === 200);
ok("cross-origin POST without a token on a token server → 401", (await req(base, { method: "POST", path: "/api/gc", headers: { origin: "http://evil.example" } })).status === 401);

// The fleet client sends $PORTBOOK_TOKEN automatically (still "secret-xyz" → matches the server).
process.env.PORTBOOK_SERVER = base;
const client = await import("../src/client.js");
const made = await client.reserve({ project: "a", port: 45990, adopt: true });
ok("client with the matching token can reserve", made.length === 1 && made[0].port === 45990);

// Change only the CLIENT's token; the server already snapshotted the original → mismatch → rejected.
process.env.PORTBOOK_TOKEN = "wrong-now";
let blocked = false; try { await client.list(); } catch { blocked = true; }
ok("client with a mismatched token is rejected", blocked);

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
