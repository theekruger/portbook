// portbook serve — a tiny, dependency-free HTTP server (Node's built-in `http`) that exposes the
// registry + ecosystem as JSON and serves the single-page dashboard. It binds to 127.0.0.1 by default
// (local-only); pass a tailnet IP via `--bind` to make it the shared "fleet" server (see docs/FLEET.md).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reserve, release, gc, list, check, scan, annotate, machineName } from "./registry.js";
import { ecosystem } from "./environments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, "..", "public", "index.html");

// Latest ecosystem each fleet machine has reported (machine -> { machine, ecosystem, at }). In-memory:
// clients re-report on demand / on a timer, so a server restart just means an empty fleet view until
// the next round of reports.
const reports = new Map();

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(data),
    // Localhost-only data; permissive CORS lets editor/webview integrations read it directly.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 1 << 20) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

export function createServer() {
  const token = process.env.PORTBOOK_TOKEN || null; // optional bearer auth, fixed at server launch
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (req.method === "OPTIONS") return send(res, 204, "");
      // When a token is configured, gate the DATA (/api/*). The dashboard shell (GET /) stays public —
      // it carries no data and prompts for the token in the browser; CLI/library clients send
      // `Authorization: Bearer <token>`. Without $PORTBOOK_TOKEN the server is open (local default).
      if (token && p.startsWith("/api/") && req.headers["authorization"] !== `Bearer ${token}`) {
        return send(res, 401, { error: "unauthorized — this portbook server requires a matching PORTBOOK_TOKEN" });
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
        return send(res, 200, { server: machineName(), at: new Date().toISOString(), reservations: list(), reports: Object.fromEntries(reports) });
      }

      if (req.method === "POST" && p === "/api/reserve") return send(res, 200, await reserve(await readBody(req)));
      if (req.method === "POST" && p === "/api/release") return send(res, 200, { released: await release(await readBody(req)) });
      if (req.method === "POST" && p === "/api/gc") return send(res, 200, { reclaimed: (await gc()).length });
      if (req.method === "POST" && p === "/api/report") {
        const b = await readBody(req);
        if (b && b.machine) reports.set(b.machine, { machine: b.machine, ecosystem: b.ecosystem || null, at: new Date().toISOString() });
        return send(res, 200, { ok: true, machines: reports.size });
      }

      return send(res, 404, { error: "not found", path: p });
    } catch (e) {
      send(res, 400, { error: e?.message || String(e) });
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
