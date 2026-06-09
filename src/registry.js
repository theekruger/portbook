// portbook core — a lock-guarded, machine-wide port reservation registry.
//
// Storage: a single JSON file under ~/.portbook (override with $PORTBOOK_DIR), guarded by an atomic
// mkdir lock so concurrent agents/processes can't corrupt it. Writes are atomic (temp + rename).
// Every reservation records who owns the port, why, on which machine, and (optionally) the owning
// PID + a TTL, so dead or stale holds are auto-reclaimed. `reserve` also reconciles against the real
// OS state, so the registry reflects reality — not just bookkeeping.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export const DIR = process.env.PORTBOOK_DIR || path.join(os.homedir(), ".portbook");
export const FILE = path.join(DIR, "registry.json");
const LOCK = path.join(DIR, "registry.lock");
const LOCK_STALE_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// This machine's identity in the registry. Override with $PORTBOOK_MACHINE — useful for a reporter
// running inside a container/VM that should report a logical name, or to simulate machines in tests.
// Read live (a function, not a const) so it can change per call.
export const machineName = () => process.env.PORTBOOK_MACHINE || os.hostname();

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

async function acquireLock(timeoutMs = 5000) {
  ensureDir();
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(LOCK); return; } // mkdir is atomic: fails if another holder exists
    catch {
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { try { fs.rmdirSync(LOCK); } catch { /* race */ } continue; }
      } catch { /* lock vanished — retry */ }
      if (Date.now() - start > timeoutMs) throw new Error("registry is locked by another process (retry, or run `portbook gc`)");
      await sleep(40);
    }
  }
}
function releaseLock() { try { fs.rmdirSync(LOCK); } catch { /* already gone */ } }
export async function withLock(fn) { await acquireLock(); try { return await fn(); } finally { releaseLock(); } }

export function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!Array.isArray(j.reservations)) j.reservations = [];
    return j;
  } catch { return { version: 1, reservations: [] }; }
}
export function writeRegistry(reg) {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, FILE); // atomic replace
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Resolves true if `port` can be bound right now (OS-level free). Checks the given host, else all
// interfaces (strictest — flags anything bound anywhere).
export function isPortFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try { host ? srv.listen(port, host) : srv.listen(port); } catch { resolve(false); }
  });
}

// Drop reservations that are expired or whose owning PID is gone. Returns the removed entries.
// PID liveness only means something on the machine that made the reservation, so we skip the PID
// check for holds owned by a different machine (a future fleet/server will reconcile those).
export function reconcile(reg) {
  const t = Date.now();
  const me = machineName();
  const kept = [], removed = [];
  for (const r of reg.reservations) {
    const expired = r.expiresAt && Date.parse(r.expiresAt) < t;
    const local = !r.machine || r.machine === me;
    const dead = local && r.pid && !pidAlive(r.pid);
    (expired || dead ? removed : kept).push(r);
  }
  reg.reservations = kept;
  return removed;
}

export async function reserve(opts = {}) {
  const { project, port, count = 1, purpose = null, owner = null, host = null, pid = null, ttlSec = null,
    machine = machineName(), probe = true } = opts;
  const rangeStart = opts.rangeStart || 4000;
  const rangeEnd = opts.rangeEnd || 4999;
  if (!project) throw new Error("reserve requires a --project");
  if (port != null && !validPort(port)) throw new Error(`invalid port ${port} — must be an integer 1-65535`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid --count ${count} — must be a positive integer`);
  return withLock(async () => {
    const reg = readRegistry();
    reconcile(reg);
    // Conflicts are PER MACHINE: port 5000 on machine A and on machine B don't collide. `probe` runs the
    // OS-free check locally; a fleet client sets probe:false because it already checked on its own machine.
    const taken = new Map(reg.reservations.map((r) => [`${r.machine}:${r.port}`, r]));
    const key = (p) => `${machine}:${p}`;
    const chosen = [];
    if (port != null) {
      if (taken.has(key(port))) throw new Error(`port ${port} is already reserved on ${machine} by "${taken.get(key(port)).project}"`);
      // `adopt` registers a port you ALREADY run on (skips the free check). Otherwise it must be free.
      if (probe && !opts.adopt && !(await isPortFree(port, host))) {
        throw new Error(`port ${port} is in use at the OS level. Use --adopt if this is your own running service.`);
      }
      chosen.push(port);
    } else {
      for (let p = rangeStart; p <= rangeEnd && chosen.length < count; p++) {
        if (!taken.has(key(p)) && (!probe || (await isPortFree(p, host)))) chosen.push(p);
      }
      if (chosen.length < count) throw new Error(`could not find ${count} free port(s) in ${rangeStart}-${rangeEnd}`);
    }
    const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
    const made = chosen.map((p) => ({
      id: uid(), port: p, project, purpose, owner, pid, host: host || "*", machine,
      status: opts.adopt ? "active" : "reserved", reservedAt: nowISO(), expiresAt,
    }));
    reg.reservations.push(...made);
    writeRegistry(reg);
    return made;
  });
}

export async function release(opts = {}) {
  const { project, port, id, machine } = opts;
  if (port == null && !project && !id) throw new Error("release requires --port, --project, or --id");
  // When `machine` is given (fleet clients pass their own), port/project matches are scoped to it so a
  // client only releases its own holds; `id` is globally unique so it ignores the scope.
  const onMachine = (r) => !machine || r.machine === machine;
  return withLock(async () => {
    const reg = readRegistry();
    const before = reg.reservations.length;
    reg.reservations = reg.reservations.filter(
      (r) => !((id && r.id === id) || (port != null && r.port === port && onMachine(r)) || (project && r.project === project && onMachine(r)))
    );
    writeRegistry(reg);
    return before - reg.reservations.length;
  });
}

export async function gc() {
  return withLock(async () => {
    const reg = readRegistry();
    const removed = reconcile(reg);
    writeRegistry(reg);
    return removed;
  });
}

export function list(opts = {}) {
  const reg = readRegistry();
  let rows = reg.reservations.slice().sort((a, b) => a.port - b.port);
  if (opts.project) rows = rows.filter((r) => r.project === opts.project);
  return rows;
}

// Annotate rows with live OS truth: `bound` (something is actually listening now, read from the OS's
// own listener table — which sees interface-specific binds that a wildcard probe would miss, e.g. a
// service bound only to a Tailscale IP) and `stale` (the owning PID is dead or the TTL expired — a
// candidate for `gc`). Read-only; never mutates. Liveness can only be observed for reservations held
// by THIS machine; reservations on another machine report bound:null (unknown from here).
export async function annotate(rows) {
  const t = Date.now();
  const me = machineName();
  const listeners = await getListeners();
  const known = listeners.length > 0; // an empty result almost always means enumeration failed
  const listening = new Set(listeners.map((l) => l.port));
  return rows.map((r) => {
    const expired = !!(r.expiresAt && Date.parse(r.expiresAt) < t);
    const local = !r.machine || r.machine === me;
    const dead = !!(local && r.pid && !pidAlive(r.pid));
    const bound = local && known ? listening.has(r.port) : null;
    return { ...r, bound, stale: expired || dead, expired, dead };
  });
}

export async function check(port, host) {
  if (!validPort(port)) throw new Error(`invalid port ${port} — must be an integer 1-65535`);
  const reg = readRegistry();
  const reservation = reg.reservations.find((r) => r.port === port) || null;
  const osFree = await isPortFree(port, host);
  return { port, reservation, osFree };
}

// Best-effort enumeration of TCP ports in LISTEN state on THIS machine, with owning PID/process.
// Returns [] if the OS tooling isn't available (callers treat that as a registry-only view).
export async function getListeners() {
  if (process.platform === "win32") return winListeners();
  return posixListeners();
}

// ── OS listener-table parsers ────────────────────────────────────────────────────────────────────
// Pure functions: each takes the raw text/JSON one tool emits and returns deduped [{port, pid, proc}]
// (first occurrence of a port wins, matching how the OS lists the primary binding first). Kept apart
// from the shell-out wrappers so they're unit-testable on any OS without the tool being installed.
// The last segment after ":" is the port for every address form we see — IPv4 `127.0.0.1:6379`,
// IPv6 `[::]:8080`, and wildcard `0.0.0.0:135` all end in `:<port>`.
const portOf = (addr) => Number(String(addr).slice(String(addr).lastIndexOf(":") + 1));

// `netstat -ano` (Windows). Lines look like: `  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1032`.
// Keep only TCP rows in LISTENING state; PID is the trailing column. No process name from netstat.
export function parseNetstat(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== "TCP" || !t.includes("LISTENING")) continue;
    const port = portOf(t[1] || "");
    const pid = Number(t[t.length - 1]);
    if (port && !out.has(port)) out.set(port, { port, pid: pid || null, proc: null });
  }
  return [...out.values()];
}

// `ss -tlnpH` (Linux). Lines look like:
//   `LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=1234,fd=6))`
// Local address is column 4 (0-indexed 3); pid + process name come from the `users:((...))` field.
export function parseSs(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    const port = portOf(cols[3] || "");
    const pidM = line.match(/pid=(\d+)/);
    const procM = line.match(/\("([^"]+)"/);
    if (port && !out.has(port)) out.set(port, { port, pid: pidM ? Number(pidM[1]) : null, proc: procM ? procM[1] : null });
  }
  return [...out.values()];
}

// `lsof -nP -iTCP -sTCP:LISTEN` (macOS/BSD). The first line is a header we skip. Lines look like:
//   `node    4100 ctk   23u  IPv4 0x... 0t0 TCP 127.0.0.1:4100 (LISTEN)`
// Command is column 0, PID column 1, the address (with port) column 8.
export function parseLsof(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 9) continue;
    const port = portOf(c[8] || "");
    if (port && !out.has(port)) out.set(port, { port, pid: Number(c[1]) || null, proc: c[0] || null });
  }
  return [...out.values()];
}

// Get-NetTCPConnection (Windows, preferred path) emits JSON — either a single object or an array of
// `{ port, pid, proc }`. Parse the text, then normalize each row the same way the others produce.
export function parsePowershell(text) {
  const j = JSON.parse((String(text).trim() || "[]"));
  const arr = Array.isArray(j) ? j : [j];
  return arr.filter((x) => x && x.port).map((x) => ({ port: Number(x.port), pid: x.pid ?? null, proc: x.proc || null }));
}

async function winListeners() {
  // Prefer Get-NetTCPConnection (locale-independent, gives the owning PID directly); fall back to
  // parsing `netstat -ano` if PowerShell or the NetTCPIP module isn't available.
  const ps =
    "Get-NetTCPConnection -State Listen | Group-Object LocalPort | ForEach-Object {" +
    " $o=$_.Group[0]; $n=$null; try { $n=(Get-Process -Id $o.OwningProcess -EA Stop).ProcessName } catch {};" +
    " [pscustomobject]@{ port=[int]$_.Name; pid=$o.OwningProcess; proc=$n } } | ConvertTo-Json -Compress";
  try {
    const { stdout } = await pexec("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 12000, maxBuffer: 1 << 22 });
    return parsePowershell(stdout);
  } catch {
    return netstatListeners();
  }
}

async function netstatListeners() {
  try {
    const { stdout } = await pexec("netstat", ["-ano"], { timeout: 12000, maxBuffer: 1 << 22 });
    return parseNetstat(stdout);
  } catch { return []; }
}

async function posixListeners() {
  // Try `ss` (Linux), then `lsof` (macOS/BSD). Best-effort; either may be absent.
  try {
    const { stdout } = await pexec("ss", ["-tlnpH"], { timeout: 12000, maxBuffer: 1 << 22 });
    const rows = parseSs(stdout);
    if (rows.length) return rows;
  } catch { /* fall through to lsof */ }
  try {
    const { stdout } = await pexec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 12000, maxBuffer: 1 << 22 });
    return parseLsof(stdout);
  } catch { return []; }
}

// Cross-reference what's ACTUALLY listening on this machine against the registry:
//   managed   — listening AND reserved here
//   unmanaged — listening but NOT in portbook (a port you should probably reserve or investigate)
//   ghosts    — reserved but nothing is listening (a stale hold, or a server that hasn't started)
export async function scan() {
  const reg = readRegistry();
  const reserved = new Map(reg.reservations.map((r) => [r.port, r]));
  const listeners = await getListeners();
  const seen = new Set();
  const managed = [], unmanaged = [];
  for (const l of listeners) {
    seen.add(l.port);
    const r = reserved.get(l.port);
    (r ? managed : unmanaged).push({ ...l, reservation: r || null });
  }
  const ghosts = reg.reservations.filter((r) => !seen.has(r.port));
  return { machine: os.hostname(), listeners, managed, unmanaged, ghosts };
}
