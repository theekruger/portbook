// portbook ⇄ Tailscale — native management of tailnet staging origins.
//
// A Tailscale node has ONE MagicDNS hostname; a service worker (PWA) is origin-scoped (host:port), so
// two apps proxied at the same host:port collide. The fix is "one dedicated tailscale HTTPS port per
// app-origin, tracked in portbook" — `expose` reserves the local port AND runs `tailscale serve`,
// recording the resulting public origin so it can never drift untracked; `release` tears the serve
// mapping down with the reservation; `origins`/`doctor` reconcile the ledger against live serve state.
//
// Everything here shells out to the `tailscale` CLI (on PATH), best-effort and dependency-free in the
// same spirit as environments.js: the pure parsers are split from the shell-out wrappers so they're
// unit-testable on any machine without tailscale installed, and a missing/failed `tailscale` surfaces
// as a clean error on the tailscale-touching commands without breaking the rest of portbook.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// Raised when the `tailscale` CLI is absent or refuses to answer. bin/registry catch this so the
// tailscale-touching commands (expose/origins/doctor/release-teardown) fail cleanly while every other
// portbook command keeps working with no tailscale on the machine at all.
export class TailscaleUnavailable extends Error {
  constructor(detail) {
    super(`tailscale CLI is unavailable (${detail}) — install Tailscale and ensure \`tailscale\` is on PATH`);
    this.name = "TailscaleUnavailable";
  }
}

// ── pure parsers ───────────────────────────────────────────────────────────────────────────────────
// Each takes the raw JSON one `tailscale` subcommand emits and returns a normalized shape. Kept apart
// from the shell-out wrappers below so they're testable without the CLI.

// `tailscale status --json` → the node's MagicDNS hostname (Self.DNSName, trailing dot stripped), e.g.
// "laptop-glklll8b.tailf23b1e.ts.net". Returns null if the field is missing.
export function parseMagicDnsName(text) {
  let j;
  try { j = JSON.parse(String(text || "").trim() || "{}"); } catch { return null; }
  const dns = j && j.Self && typeof j.Self.DNSName === "string" ? j.Self.DNSName : null;
  if (!dns) return null;
  return dns.replace(/\.$/, ""); // DNSName carries a trailing dot ("host.tailnet.ts.net.")
}

// `tailscale serve status --json` → the live HTTPS serve mappings as
//   [{ host, tsPort, localPort, url }]
// from the `.Web` map (keyed "host:port") whose "/" handler proxies http://127.0.0.1:<localPort>.
// `.TCP[port].HTTPS` confirms the port terminates TLS. Foreign/path handlers we can't model collapse
// to localPort:null (still surfaced as a mapping so `origins`/`doctor` can flag them). Empty/!serve → [].
export function parseServeStatus(text) {
  let j;
  try { j = JSON.parse(String(text || "").trim() || "{}"); } catch { return []; }
  const web = j && j.Web && typeof j.Web === "object" ? j.Web : {};
  const out = [];
  for (const [hostPort, cfg] of Object.entries(web)) {
    const idx = hostPort.lastIndexOf(":");
    if (idx < 0) continue;
    const host = hostPort.slice(0, idx);
    const tsPort = Number(hostPort.slice(idx + 1));
    if (!Number.isInteger(tsPort)) continue;
    const handlers = cfg && cfg.Handlers && typeof cfg.Handlers === "object" ? cfg.Handlers : {};
    const root = handlers["/"] || Object.values(handlers)[0] || null;
    const proxy = root && typeof root.Proxy === "string" ? root.Proxy : null;
    const m = proxy ? proxy.match(/:(\d+)\/?$/) : null;
    out.push({ host, tsPort, localPort: m ? Number(m[1]) : null, url: `https://${host}:${tsPort}` });
  }
  return out.sort((a, b) => a.tsPort - b.tsPort);
}

// The tailscale HTTPS ports already in use, from serve status JSON — both the `.TCP` map (every port
// terminating TLS) and the `.Web` keys (defensive: a mapping with no matching TCP row). Used to
// auto-pick a free tsPort that avoids live serve ports.
export function parseServePorts(text) {
  let j;
  try { j = JSON.parse(String(text || "").trim() || "{}"); } catch { return new Set(); }
  const ports = new Set();
  const tcp = j && j.TCP && typeof j.TCP === "object" ? j.TCP : {};
  for (const k of Object.keys(tcp)) { const n = Number(k); if (Number.isInteger(n)) ports.add(n); }
  for (const m of parseServeStatus(text)) ports.add(m.tsPort);
  return ports;
}

// ── shell-out wrappers ───────────────────────────────────────────────────────────────────────────
// best-effort: throw TailscaleUnavailable when the CLI can't be reached, so callers fail cleanly.

async function ts(args, { timeout = 10000 } = {}) {
  try {
    const { stdout } = await pexec("tailscale", args, { timeout, maxBuffer: 1 << 22 });
    return stdout;
  } catch (e) {
    // ENOENT = not on PATH; anything else (daemon down, not logged in) we also treat as unavailable for
    // the read paths, carrying the detail so the message is actionable.
    throw new TailscaleUnavailable(e?.code === "ENOENT" ? "not found on PATH" : (e?.shortMessage || e?.message || String(e)));
  }
}

// This node's MagicDNS hostname, or throw if tailscale can't answer.
export async function magicDnsName() {
  const name = parseMagicDnsName(await ts(["status", "--json"]));
  if (!name) throw new TailscaleUnavailable("could not resolve this node's MagicDNS name from `tailscale status --json` (is the node logged in?)");
  return name;
}

// Live HTTPS serve mappings ([{host, tsPort, localPort, url}]). Throws if tailscale is unavailable.
export async function serveStatus() {
  return parseServeStatus(await ts(["serve", "status", "--json"]));
}

// The set of tailscale HTTPS ports already serving. Throws if tailscale is unavailable.
export async function servePorts() {
  return parseServePorts(await ts(["serve", "status", "--json"]));
}

// Start a background HTTPS serve mapping: tailscale serve --bg --https=<tsPort> http://127.0.0.1:<local>.
// Idempotent on tailscale's side (re-running the same mapping is a no-op). Throws if unavailable.
export async function serveOn(tsPort, localPort) {
  await ts(["serve", "--bg", `--https=${tsPort}`, `http://127.0.0.1:${localPort}`], { timeout: 20000 });
}

// Tear a serve mapping down: tailscale serve --https=<tsPort> off. Best-effort — a mapping already
// gone is fine. Throws TailscaleUnavailable only if the CLI itself can't be reached.
export async function serveOff(tsPort) {
  await ts(["serve", `--https=${tsPort}`, "off"], { timeout: 20000 });
}

// Pick a free tailscale HTTPS port: the lowest in [start..end] that is NEITHER already serving NOR in
// the caller-supplied `reserved` set (portbook-recorded tsPorts). 8443 upward mirrors the user's live
// block. Throws if none free in range.
export function pickTsPort(servingPorts, reserved = new Set(), start = 8443, end = 8543) {
  for (let p = start; p <= end; p++) {
    if (!servingPorts.has(p) && !reserved.has(p)) return p;
  }
  throw new Error(`no free tailscale HTTPS port in ${start}-${end} (all are already serving or reserved) — pass --https <port> explicitly`);
}
