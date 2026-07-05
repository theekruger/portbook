// portbook serve — a tiny, dependency-free HTTP server (Node's built-in `http`) that exposes the
// registry + ecosystem as JSON and serves the single-page dashboard. It binds to 127.0.0.1 by default
// (local-only); pass a tailnet IP via `--bind` to make it the shared "fleet" server (see docs/FLEET.md).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reserve, release, renew, gc, list, check, scan, annotate, machineName, reserveBlock, releaseBlock, listBlocks, requestPort, inbox, outbox, resolveRequest } from "./registry.js";
import { ecosystem } from "./environments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, "..", "public", "index.html");

// Latest ecosystem each fleet machine has reported (machine -> { machine, ecosystem, at }). In-memory:
// clients re-report on demand / on a timer, so a server restart just means an empty fleet view until
// the next round of reports. The key is CLIENT-controlled, so the map is bounded two ways: at most
// REPORT_CAP machines (stalest report evicted first), and machines silent past the TTL age out.
const reports = new Map();
const REPORT_CAP = 256;

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

// Buffer + parse a JSON body, capped at 1 MiB. Always SETTLES: an oversized body rejects with
// status 413 (the handler's catch answers; the rest of the body is drained, not destroyed), and a
// torn-down request ('error', or 'close' without 'end') resolves {} — otherwise the awaiting route
// handler would hang forever, leaking its frame and the buffered body.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "", done = false;
    const settle = (fn, v) => { if (!done) { done = true; fn(v); } };
    req.on("data", (d) => {
      if (done) return; // oversize already rejected — keep draining so the connection can complete
      s += d;
      if (s.length > 1 << 20) settle(reject, Object.assign(new Error("request body too large (max 1 MiB)"), { status: 413 }));
    });
    req.on("end", () => { try { settle(resolve, s ? JSON.parse(s) : {}); } catch { settle(resolve, {}); } });
    req.on("error", () => settle(resolve, {}));
    req.on("close", () => settle(resolve, {}));
  });
}

export function createServer() {
  const token = process.env.PORTBOOK_TOKEN || null; // optional bearer auth, fixed at server launch
  const reportTtlMs = Number(process.env.PORTBOOK_REPORT_TTL_MS) || 24 * 3600 * 1000; // env override is a test knob
  // Constant-time bearer check — hash both sides so neither content nor LENGTH leaks via comparison
  // timing (timingSafeEqual also requires equal-length inputs). This is the server's only auth.
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
  const authed = (req) => !!token && crypto.timingSafeEqual(sha(req.headers["authorization"] || ""), sha(`Bearer ${token}`));
  // Does the Origin header point back at this very server? (host:port match — scheme is irrelevant here)
  const sameOrigin = (origin, host) => { try { return new URL(origin).host === host; } catch { return false; } };
  const dropStale = () => { const t = Date.now(); for (const [k, v] of reports) if (t - Date.parse(v.at) > reportTtlMs) reports.delete(k); };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      // CORS: reads stay permissive (localhost-only data; lets editor/webview integrations read it
      // directly) — but ONLY reads. Approving cross-origin POSTs would let any web page the developer
      // visits drive our mutating endpoints (CSRF), so a preflight for anything but GET is refused
      // and the gate below rejects browser-originated writes outright.
      if (req.method === "GET") res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        if ((req.headers["access-control-request-method"] || "GET") !== "GET") {
          return send(res, 403, { error: "cross-origin writes are not allowed" });
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        return send(res, 204, "");
      }
      // When a token is configured, gate the DATA (/api/*). The dashboard shell (GET /) stays public —
      // it carries no data and prompts for the token in the browser; CLI/library clients send
      // `Authorization: Bearer <token>`. Without $PORTBOOK_TOKEN the server is open (local default).
      if (token && p.startsWith("/api/") && !authed(req)) {
        return send(res, 401, { error: "unauthorized — this portbook server requires a matching PORTBOOK_TOKEN" });
      }
      // CSRF gate: writes are accepted from non-browser clients (no Origin header — the CLI, Node
      // fetch, editor extensions), from our own origin (the dashboard), or with a valid bearer token.
      // Anything else is a foreign web page driving the developer's browser: refuse it.
      if (req.method === "POST" && req.headers.origin && !sameOrigin(req.headers.origin, req.headers.host) && !authed(req)) {
        return send(res, 403, { error: "cross-origin write rejected — POST must be same-origin, token-authed, or non-browser" });
      }

      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        return send(res, 200, fs.readFileSync(UI_FILE, "utf8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && p === "/api/ecosystem") return send(res, 200, await ecosystem());
      if (req.method === "GET" && p === "/api/scan") return send(res, 200, await scan());
      if (req.method === "GET" && p === "/api/list") {
        const project = url.searchParams.get("project") || undefined;
        const rows = list({ project });
        // ?raw=1 returns reservations un-annotated — fleet clients annotate locally against their own OS.
        return send(res, 200, url.searchParams.get("raw") ? rows : await annotate(rows));
      }
      if (req.method === "GET" && p.startsWith("/api/check/")) return send(res, 200, await check(Number(p.split("/").pop())));
      if (req.method === "GET" && p === "/api/fleet") {
        dropStale(); // machines that stopped reporting age out of the fleet view, not just on insert
        return send(res, 200, { server: machineName(), at: new Date().toISOString(), reservations: list(), blocks: listBlocks(), reports: Object.fromEntries(reports) });
      }
      // Port TERRITORY blocks live in the same shared ledger; raw arrays (clients judge their own machine).
      if (req.method === "GET" && p === "/api/blocks") {
        const project = url.searchParams.get("project") || undefined;
        return send(res, 200, listBlocks({ project }));
      }
      // Port REQUESTS (ask/grant/deny — see registry.js): ?project= → that project's inbox; ?from= →
      // the requester's outbox; neither → every pending ask. ?machine= scopes the inbox to the FLEET
      // CLIENT's box (the core defaults to the server's own machine — wrong from another machine).
      if (req.method === "GET" && p === "/api/requests") {
        const project = url.searchParams.get("project") || undefined;
        const from = url.searchParams.get("from") || undefined;
        const machine = url.searchParams.get("machine") || undefined;
        return send(res, 200, !project && from ? outbox({ fromProject: from }) : inbox({ project, machine }));
      }

      if (req.method === "POST" && p === "/api/reserve") return send(res, 200, await reserve(await readBody(req)));
      if (req.method === "POST" && p === "/api/release") return send(res, 200, { released: await release(await readBody(req)) });
      // Extend a TTL hold in place (no release+re-reserve snipe window). Body carries the same ANDed
      // selectors as release plus ttlSec; fleet clients pass their machine. Returns the renewed rows.
      if (req.method === "POST" && p === "/api/renew") return send(res, 200, await renew(await readBody(req)));
      if (req.method === "POST" && p === "/api/blocks") return send(res, 200, await reserveBlock(await readBody(req)));
      if (req.method === "POST" && p === "/api/blocks/release") return send(res, 200, { released: await releaseBlock(await readBody(req)) });
      // Requests: file an ask / answer one. The body carries `machine` from fleet clients (which
      // machine's port is being asked about); resolve is global by request id, no machine needed.
      if (req.method === "POST" && p === "/api/requests") return send(res, 200, await requestPort(await readBody(req)));
      if (req.method === "POST" && p === "/api/requests/resolve") return send(res, 200, await resolveRequest(await readBody(req)));
      if (req.method === "POST" && p === "/api/gc") return send(res, 200, { reclaimed: (await gc()).length });
      if (req.method === "POST" && p === "/api/report") {
        const b = await readBody(req);
        // The key is client-controlled: accept only sane string names, age out the silent, and cap
        // the map. Map iterates in insertion order and we re-insert on every report, so the first
        // key is always the stalest (LRU-ish eviction).
        if (b && typeof b.machine === "string" && b.machine && b.machine.length <= 256) {
          dropStale();
          if (!reports.has(b.machine) && reports.size >= REPORT_CAP) reports.delete(reports.keys().next().value);
          reports.delete(b.machine);
          reports.set(b.machine, { machine: b.machine, ecosystem: b.ecosystem || null, at: new Date().toISOString() });
        }
        return send(res, 200, { ok: true, machines: reports.size });
      }

      return send(res, 404, { error: "not found", path: p });
    } catch (e) {
      // Client mistakes (validation, conflicts) → 400. A ledger the server itself cannot read —
      // readRegistry/withLock throw "cannot read registry…" / "registry … is corrupt…" / "registry is
      // locked…" — is OUR fault → 500. An explicit e.status (readBody's 413) wins. Never let this
      // throw: a dead client socket must not take the process down.
      const ours = /cannot read registry|registry .* is corrupt|registry is locked/.test(e?.message || "");
      try { send(res, e?.status || (ours ? 500 : 400), { error: e?.message || String(e) }); } catch {}
    }
  });
}

// Starts the server and resolves with the live http.Server (listening). Caller keeps the process up.
export function serve({ port = 7800, bind = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, bind, () => resolve(srv));
  });
}
