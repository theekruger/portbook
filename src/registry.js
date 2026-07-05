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
import { wslListenerPorts } from "./wsl.js";

const pexec = promisify(execFile);

export const DIR = process.env.PORTBOOK_DIR || path.join(os.homedir(), ".portbook");
export const FILE = path.join(DIR, "registry.json");
export const EVENTS_FILE = path.join(DIR, "events.jsonl");
const LOCK = path.join(DIR, "registry.lock");
// Holders heartbeat (touch the lock's mtime) during slow work, so "stale" really means "crashed".
// $PORTBOOK_LOCK_STALE_MS shrinks the window so the takeover paths are testable.
const LOCK_STALE_MS = Number(process.env.PORTBOOK_LOCK_STALE_MS) || 15000;

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
  const token = `${process.pid}.${uid()}`; // identifies OUR tenancy of the lock dir
  for (;;) {
    try {
      fs.mkdirSync(LOCK); // mkdir is atomic: fails if another holder exists
      fs.writeFileSync(path.join(LOCK, "owner"), token); // so releaseLock removes only OUR lock
      return token;
    } catch {
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Takeover must be ATOMIC: a naive rmdir+mkdir lets two breakers both "win" (one silently
          // deletes the other's FRESH lock). rename hands the husk to exactly one breaker; losers
          // throw into the outer catch and retry.
          const tomb = `${LOCK}.${process.pid}.${Date.now()}.tomb`;
          fs.renameSync(LOCK, tomb);
          try {
            // Re-judge on the tomb: if it's actually FRESH we raced a brand-new holder — hand it back.
            if (Date.now() - fs.statSync(tomb).mtimeMs > LOCK_STALE_MS) fs.rmSync(tomb, { recursive: true, force: true });
            else fs.renameSync(tomb, LOCK);
          } catch { try { fs.rmSync(tomb, { recursive: true, force: true }); } catch { /* leaked tomb — inert */ } }
          continue;
        }
      } catch { /* lock vanished or another breaker won — retry */ }
      if (Date.now() - start > timeoutMs) throw new Error("registry is locked by another process (retry, or run `portbook gc`)");
      await sleep(40);
    }
  }
}
// Remove the lock only if WE still own it: if our lock was judged stale and taken over, the new
// holder's lock must survive our release (an ownerless rmdir would admit a third process mid-write).
function releaseLock(token) {
  try {
    if (fs.readFileSync(path.join(LOCK, "owner"), "utf8") !== token) return; // not ours anymore
    fs.rmSync(LOCK, { recursive: true, force: true });
  } catch { /* already gone */ }
}
// Heartbeat: a holder doing slow work (e.g. probing a big port range) refreshes the lock's mtime so
// a live-but-slow holder is never judged stale and stolen from.
function touchLock() { try { const t = new Date(); fs.utimesSync(LOCK, t, t); } catch { /* best-effort */ } }
export async function withLock(fn) { const token = await acquireLock(); try { return await fn(); } finally { releaseLock(token); } }

export function readRegistry() {
  let raw;
  try { raw = fs.readFileSync(FILE, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return { version: 1, reservations: [], blocks: [], requests: [], origins: [] }; // no registry yet
    // EBUSY/EPERM/EACCES (AV / backup / sync tools) etc. — surface it. Returning "empty" here would
    // make the caller's next writeRegistry silently wipe the whole ledger.
    throw new Error(`cannot read registry ${FILE}: ${e.message}`);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a registry object");
    if (!Array.isArray(j.reservations)) j.reservations = [];
    if (!Array.isArray(j.blocks)) j.blocks = [];
    if (!Array.isArray(j.requests)) j.requests = [];
    // origins[] (tailnet staging origins) is a v0.6.0 addition — a registry written by an older
    // portbook simply lacks the field; normalize it so every reader/writer round-trips it gracefully
    // (additive migration: nothing else in the on-disk shape changes).
    if (!Array.isArray(j.origins)) j.origins = [];
    return j;
  } catch (e) {
    // Corrupt ledger: QUARANTINE the evidence and abort loudly — never read "empty" and let a
    // mutator write a one-entry registry over everyone's reservations and blocks.
    const quarantine = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, quarantine); } catch { /* best-effort */ }
    throw new Error(`registry ${FILE} is corrupt (${e.message}) — moved to ${quarantine}; inspect/restore it, then retry`);
  }
}
export function writeRegistry(reg) {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  // Write + fsync the temp BEFORE the atomic rename: rename metadata can be journaled ahead of file
  // data (NTFS/ext4), and a power cut then leaves a zero-length registry.
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(reg, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, FILE); // atomic replace
}

// ── AUDIT TRAIL: an append-only events ledger answering "who reserved/released/reclaimed this port,
// when, and why" — the forensic record the registry's current-state snapshot can't provide (the
// project's origin story is an agent silently killing another project's server; this is how you find
// out afterwards). Mutators call logEvents() INSIDE their lock, right after writeRegistry, so the
// event order matches the write order. Logging is strictly best-effort: an events failure must never
// fail the mutation it describes. One rotation generation (events.jsonl → events.jsonl.1) caps disk.
const EVENTS_MAX_BYTES = Number(process.env.PORTBOOK_EVENTS_MAX_BYTES) || 1 << 20; // ~1 MiB per generation
const ev = (op, fields) => ({ at: nowISO(), machine: machineName(), op, ...fields });
function logEvents(events) {
  if (!events || !events.length) return;
  try {
    ensureDir();
    try { if (fs.statSync(EVENTS_FILE).size > EVENTS_MAX_BYTES) fs.renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`); } catch { /* no file yet, or rotate raced — fine */ }
    fs.appendFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch { /* best-effort — never fail the mutation being logged */ }
}
// Events for rows reconcile() pruned — carries WHY each hold was reclaimed (the whole point).
function gcEvents(removed) {
  const t = Date.now();
  return removed.map((r) => ev("gc", {
    port: r.port, project: r.project, owner: r.owner, pid: r.pid || undefined,
    reason: r.expiresAt && Date.parse(r.expiresAt) < t ? "ttl-expired" : "dead-pid",
  }));
}
// Read the trail (both generations, oldest→newest), filtered by ANDed selectors, capped to the LAST
// `limit` rows. Read-only, tolerant of torn/corrupt lines (a crash mid-append loses one line, not all).
export function readEvents(opts = {}) {
  const { project, port, op, limit = 200 } = opts;
  const rows = [];
  for (const f of [`${EVENTS_FILE}.1`, EVENTS_FILE]) {
    let raw; try { raw = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn line — skip */ }
    }
  }
  return rows.filter((e) =>
    (!project || e.project === project) && (port == null || e.port === port) && (!op || e.op === op)
  ).slice(-limit);
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// ── PID IDENTITY: a PID alone can lie — the OS reuses them, so "pid 1234 is alive" may be a NEW,
// unrelated process wearing a dead server's number (a hold that should have been reclaimed looks
// alive forever). The fix: record the process's START TIME with the PID at reserve time, and let gc's
// deep check compare — same pid + different start = different process = stale hold. Best-effort on
// every platform; null means "couldn't tell", which callers treat as "don't judge".

// `ps -o etime=` emits [[dd-]hh:]mm:ss — parse to seconds. Exported for tests.
export function parseEtime(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}

// Batch start times for a set of PIDs → Map<pid, epochMs|null>. One shell-out for the whole batch.
export async function pidStartTimes(pids) {
  const out = new Map(pids.map((p) => [p, null]));
  if (!pids.length) return out;
  try {
    if (process.platform === "win32") {
      // -EA SilentlyContinue: dead PIDs in the batch must not fail the whole query.
      const ps = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object {` +
        ` [pscustomobject]@{ pid=$_.Id; start=[int64](($_.StartTime).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } } | ConvertTo-Json -Compress`;
      const { stdout } = await pexec("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 12000, maxBuffer: 1 << 20 });
      const j = JSON.parse(String(stdout).trim() || "[]");
      for (const row of Array.isArray(j) ? j : [j]) if (row && row.pid) out.set(Number(row.pid), Number(row.start) || null);
    } else {
      // etime (elapsed) is portable across Linux/macOS/BSD where etimes/lstart are not; second
      // precision is plenty — the reuse comparison allows multi-second slack anyway.
      const { stdout } = await pexec("ps", ["-o", "pid=,etime=", "-p", pids.join(",")], { timeout: 8000, maxBuffer: 1 << 20 });
      const now = Date.now();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)$/);
        const sec = m ? parseEtime(m[2]) : null;
        if (m && sec != null) out.set(Number(m[1]), now - sec * 1000);
      }
    }
  } catch { /* tooling absent/slow — every pid stays null (unjudgeable) */ }
  return out;
}

// Probe a bind, preserving WHY it failed: EADDRINUSE = something holds the port; EACCES/EPERM = the
// OS forbids binding it at all (Windows excluded port ranges, privileged ports) — nobody can use it.
export function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve({ free: false, code: e?.code || null }));
    srv.once("listening", () => srv.close(() => resolve({ free: true, code: null })));
    try { host ? srv.listen(port, host) : srv.listen(port); } catch (e) { resolve({ free: false, code: e?.code || null }); }
  });
}
const DENIED = new Set(["EACCES", "EACCESS", "EPERM"]); // bind forbidden by the OS — NOT "in use"
// Resolves true if `port` can be bound right now (OS-level free). Checks the given host, else all
// interfaces (strictest — flags anything bound anywhere).
export async function isPortFree(port, host) { return (await probePort(port, host)).free; }

// Requests are negotiation messages, not holds: resolved ones evaporate after a day, unanswered ones
// after a week, so inboxes never silt up. Read live (functions, like machineName) so tests can shrink
// a window per call, as $PORTBOOK_LOCK_STALE_MS does for the lock. The two windows are SEPARATE env
// hooks on purpose: tuning how fast verdicts evaporate must never silently prune a still-pending ask.
const REQUEST_TTL_MS = () => Number(process.env.PORTBOOK_REQUEST_TTL_MS) || 24 * 60 * 60 * 1000;
const REQUEST_PENDING_TTL_MS = () => Number(process.env.PORTBOOK_REQUEST_PENDING_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

// Drop reservations that are expired or whose owning PID is gone. Returns the removed entries.
// PID liveness only means something on the machine that made the reservation, so we skip the PID
// check for holds owned by a different machine (a future fleet/server will reconcile those).
// Also prunes aged-out requests (see TTLs above). Blocks are territory — never touched here.
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
  // A resolved request ages from its resolution, a pending one from its filing; an unparseable
  // timestamp keeps the row (mirroring the lenient expiresAt check above — NaN never prunes).
  reg.requests = (reg.requests || []).filter((q) => {
    const pending = q.status === "pending";
    const ts = Date.parse(pending ? q.createdAt : q.resolvedAt || q.createdAt);
    return !(ts && t - ts > (pending ? REQUEST_PENDING_TTL_MS() : REQUEST_TTL_MS()));
  });
  return removed;
}

export async function reserve(opts = {}) {
  const { project, port, count = 1, purpose = null, owner = null, host = null, pid = null, ttlSec = null,
    machine = machineName(), probe = true } = opts;
  const explicitRange = opts.rangeStart != null || opts.rangeEnd != null;
  const rangeStart = opts.rangeStart || 4000;
  const rangeEnd = opts.rangeEnd || 4999;
  if (!project) throw new Error("reserve requires a --project");
  if (port != null && !validPort(port)) throw new Error(`invalid port ${port} — must be an integer 1-65535`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid --count ${count} — must be a positive integer`);
  return withLock(async () => {
    const reg = readRegistry();
    const pruned = reconcile(reg); // logged below — auto-reclaims are exactly what the audit trail must record
    const me = machineName();
    const blocks = reg.blocks || [];
    // WSL2 shares the host's effective localhost port namespace (it forwards distro ports to the
    // Windows host — and the host's own bind test can SUCCEED on a port a distro is serving, silently
    // shadowing it). So ports listening inside a running distro are TAKEN here. One batch query per
    // reserve; empty off-Windows / on failure / with $PORTBOOK_NO_WSL=1. Skipped for adopt (the point
    // is registering something already running) and probe:false (a fleet server trusting the client).
    touchLock(); // enumerating WSL can be slow — prove we're alive, not crashed
    const wslBusy = probe && !opts.adopt ? await wslListenerPorts() : new Map();
    // A port is in a FOREIGN block when another project owns a block on THIS machine that spans it.
    // Your own project's block never blocks you (that's the whole point of reserving territory).
    // Rows/blocks without a .machine are LEGACY entries written by this machine — normalize with `me`
    // (keying them as `undefined:<port>` made them invisible to the conflict check: double-booking).
    const foreignBlock = (p) =>
      blocks.find((b) => (b.machine || me) === machine && b.project !== project && b.rangeStart <= p && p <= b.rangeEnd);
    // Conflicts are PER MACHINE: port 5000 on machine A and on machine B don't collide. `probe` runs the
    // OS-free check locally; a fleet client sets probe:false because it already checked on its own machine.
    const taken = new Map(reg.reservations.map((r) => [`${r.machine || me}:${r.port}`, r]));
    const key = (p) => `${machine}:${p}`;
    const chosen = [];
    if (port != null) {
      if (taken.has(key(port))) throw new Error(`port ${port} is already reserved on ${machine} by "${taken.get(key(port)).project}"`);
      // GRANTED, unconsumed requests on this port (see requestPort/resolveRequest). For the grantee
      // they're the one-shot pass through the GRANTING project's block; for everyone else they're a
      // PROMISE — resolveRequest guarantees the grant→reserve handover is ledger-snipe-free, so until
      // the grantee consumes the grant (or reconcile ages it out) nobody else may claim the port.
      const grants = (reg.requests || []).filter((q) => q.status === "granted" && !q.consumed &&
        q.port === port && (q.targetMachine || me) === machine);
      const mine = grants.filter((q) => q.fromProject === project);
      if (!mine.length && grants.length) {
        throw new Error(`port ${port} on ${machine} is granted to "${grants[0].fromProject}" (request ${grants[0].id}) — request it or pick another port`);
      }
      const fb = foreignBlock(port);
      // A pass opens only the wall of the project that GRANTED it: territory that changed hands after
      // the grant stays shut — the new owner never consented to the old owner's promise.
      if (fb && !mine.some((q) => q.targetProject === fb.project)) {
        throw new Error(`port ${port} is inside "${fb.project}"'s reserved block ${fb.rangeStart}-${fb.rangeEnd}`);
      }
      // `adopt` registers a port you ALREADY run on (skips the free check). Otherwise it must be free.
      if (probe && !opts.adopt) {
        touchLock(); // heartbeat — a slow probe must not make us look crashed
        const pr = await probePort(port, host);
        if (!pr.free) {
          throw new Error(DENIED.has(pr.code)
            ? `port ${port} can't be bound on this OS (an excluded port range — on Windows see \`netsh interface ipv4 show excludedportrange protocol=tcp\` — or a privileged port). --adopt won't help: your server can't bind it either.`
            : `port ${port} is in use at the OS level. Use --adopt if this is your own running service.`);
        }
        if (wslBusy.has(port)) {
          throw new Error(`port ${port} is free on the Windows host but LISTENING inside WSL distro "${wslBusy.get(port)}" — WSL2 shares localhost, so binding it would collide/shadow that service. Pick another port, or --adopt if that service is this project's.`);
        }
      }
      // Burn the grantee's pass(es) only on SUCCESS, in the same locked write as the reservation —
      // never replayable, and a throw above (port OS-busy) never reached writeRegistry, so the
      // grant survives a retry.
      for (const q of mine) q.consumed = true;
      chosen.push(port);
    } else {
      // Auto-pick. If the caller didn't ask for an explicit range and this project owns block(s) on
      // this machine, hunt WITHIN its own territory (ascending) instead of the default 4000-4999.
      const own = !explicitRange
        ? blocks.filter((b) => (b.machine || me) === machine && b.project === project)
            .sort((a, b) => a.rangeStart - b.rangeStart)
        : [];
      const spans = own.length ? own.map((b) => [b.rangeStart, b.rangeEnd]) : [[rangeStart, rangeEnd]];
      // Ports mid-handover (granted to ANOTHER project, unconsumed) are off-limits to auto-pick too —
      // an innocent auto-picker must not swallow a promised port before its grantee reserves it.
      const promised = new Set((reg.requests || [])
        .filter((q) => q.status === "granted" && !q.consumed && q.fromProject !== project && (q.targetMachine || me) === machine)
        .map((q) => q.port));
      let denied = 0; // ports the OS refuses to let ANYONE bind (excluded ranges / privileged)
      outer: for (const [lo, hi] of spans) {
        for (let p = lo; p <= hi && chosen.length < count; p++) {
          if (foreignBlock(p) || taken.has(key(p)) || promised.has(p) || wslBusy.has(p)) continue;
          if (!probe) { chosen.push(p); continue; }
          touchLock(); // heartbeat: probing a big range is slow — prove we're alive, not crashed
          const pr = await probePort(p, host);
          if (pr.free) chosen.push(p);
          else if (DENIED.has(pr.code)) denied++;
        }
        if (chosen.length >= count) break outer;
      }
      if (chosen.length < count) {
        const where = own.length ? `"${project}"'s block(s)` : `${rangeStart}-${rangeEnd}`;
        throw new Error(`could not find ${count} free port(s) in ${where}` +
          (denied ? ` (${denied} port(s) there are OS-excluded/privileged — unbindable)` : ""));
      }
    }
    const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
    // Stamp the PID's start time so gc's deep check can spot PID REUSE later (same number, different
    // process). Our own PID is free to stamp; others cost one guarded shell-out. null = "unknown" —
    // the deep check then simply never judges this row.
    let pidStartedAt = null;
    if (pid) {
      touchLock();
      pidStartedAt = pid === process.pid
        ? Math.round(Date.now() - process.uptime() * 1000)
        : (await pidStartTimes([pid])).get(pid);
    }
    const made = chosen.map((p) => ({
      id: uid(), port: p, project, purpose, owner, pid, pidStartedAt, host: host || "*", machine,
      status: opts.adopt ? "active" : "reserved", reservedAt: nowISO(), expiresAt,
    }));
    reg.reservations.push(...made);
    writeRegistry(reg);
    logEvents([...gcEvents(pruned), ...made.map((m) => ev(opts.adopt ? "adopt" : "reserve",
      { port: m.port, project, owner, pid: pid || undefined, ttlSec: ttlSec || undefined, purpose: purpose || undefined }))]);
    return made;
  });
}

export async function release(opts = {}) {
  const { project, port, id, machine } = opts;
  if (port == null && !project && !id) throw new Error("release requires --port, --project, or --id");
  // Supplied selectors are ANDed — a row goes only if it matches EVERY one — so `--project X --port P`
  // releases X's hold on P and never another project's P (a union would silently widen the blast
  // radius). When `machine` is given (fleet clients pass their own), port/project matches are scoped
  // to it so a client only releases its own holds; `id` is globally unique so it ignores the scope.
  const onMachine = (r) => !machine || r.machine === machine;
  return withLock(async () => {
    const reg = readRegistry();
    const before = reg.reservations.length;
    const hit = (r) => (!id || r.id === id) && (port == null || r.port === port) && (!project || r.project === project) && (!!id || onMachine(r));
    const dropped = reg.reservations.filter(hit);
    reg.reservations = reg.reservations.filter((r) => !hit(r));
    // Drop any tailnet staging origins anchored to the released {project, local port} in the SAME
    // locked write — no orphans. An origin keys on its LOCAL port (the thing being released), and is
    // matched by the same ANDed selectors (id matches the origin's OWN id; machine scopes it). The
    // bin/teardown layer reads originsFor() first to run `tailscale serve … off` for each before this.
    const originHit = (o) => (!id || o.id === id) && (port == null || o.localPort === port) && (!project || o.project === project) && (!!id || !machine || (o.machine || machine) === machine);
    const originsDropped = (reg.origins || []).filter(originHit);
    reg.origins = (reg.origins || []).filter((o) => !originHit(o));
    writeRegistry(reg);
    logEvents([
      ...dropped.map((r) => ev("release", { port: r.port, project: r.project, owner: r.owner })),
      ...originsDropped.map((o) => ev("origin-release", { port: o.localPort, tsPort: o.tsPort, project: o.project, url: o.url })),
    ]);
    return before - reg.reservations.length;
  });
}

// ── RENEW: extend a TTL hold's lifetime without releasing + re-reserving (a race window someone else
// could snipe). Only rows that ALREADY carry an expiresAt are touched — silently attaching a TTL to a
// PERMANENT hold would flip its contract from "lives until released" to "evaporates", the opposite of
// what the caller wants from "keep my hold alive". Same ANDed selectors as release(). Returns the
// renewed rows (possibly empty — the CLI reports the count, mirroring release).
export async function renew(opts = {}) {
  const { project, port, id, ttlSec, machine } = opts;
  if (port == null && !project && !id) throw new Error("renew requires --port, --project, or --id");
  if (!Number.isInteger(ttlSec) || ttlSec < 1) throw new Error("renew requires --ttl <seconds> (the new lifetime from now)");
  const onMachine = (r) => !machine || r.machine === machine;
  return withLock(async () => {
    const reg = readRegistry();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    const renewed = reg.reservations.filter((r) =>
      r.expiresAt && (!id || r.id === id) && (port == null || r.port === port) && (!project || r.project === project) && (!!id || onMachine(r)));
    for (const r of renewed) r.expiresAt = expiresAt;
    writeRegistry(reg);
    logEvents(renewed.map((r) => ev("renew", { port: r.port, project: r.project, owner: r.owner, ttlSec })));
    return renewed;
  });
}

// ── Port TERRITORY: a project claims a contiguous range it owns, so its own auto-picks land inside it
// and everyone else is steered away. Blocks are PERSISTENT (no pid/ttl — never reconciled or gc'd);
// conflicts are PER MACHINE, mirroring reservations. A missing .machine is treated as this machine.
export async function reserveBlock(opts = {}) {
  const { project, rangeStart, rangeEnd, owner = null, purpose = null, machine = machineName() } = opts;
  if (!project) throw new Error("reserveBlock requires a --project");
  if (!validPort(rangeStart) || !validPort(rangeEnd) || rangeStart > rangeEnd) {
    throw new Error(`invalid block range ${rangeStart}-${rangeEnd} — need 1-65535 with start <= end`);
  }
  return withLock(async () => {
    const reg = readRegistry();
    const pruned = reconcile(reg); // logged only after the write that persists it, like reserve()
    const here = (m) => (m || machine) === machine; // missing machine == this machine
    // IDEMPOTENT under the lock: re-claiming an IDENTICAL block (same project/machine/range) — a re-run
    // bootstrap, `portbook import`, or two agents racing — returns the existing row, never a duplicate.
    const dup = reg.blocks.find((b) => here(b.machine) && b.project === project && b.rangeStart === rangeStart && b.rangeEnd === rangeEnd);
    if (dup) { writeRegistry(reg); logEvents(gcEvents(pruned)); return dup; }
    // (a) No overlap with ANOTHER project's block on this machine (your own block overlapping is fine).
    for (const b of reg.blocks) {
      if (!here(b.machine) || b.project === project) continue;
      if (rangeStart <= b.rangeEnd && b.rangeStart <= rangeEnd) {
        throw new Error(`range ${rangeStart}-${rangeEnd} overlaps "${b.project}"'s block ${b.rangeStart}-${b.rangeEnd}`);
      }
    }
    // (b) Don't swallow another project's individual port reservation on this machine.
    for (const r of reg.reservations) {
      if (!here(r.machine) || r.project === project) continue;
      if (r.port >= rangeStart && r.port <= rangeEnd) {
        throw new Error(`range ${rangeStart}-${rangeEnd} contains "${r.project}"'s reservation on port ${r.port}`);
      }
    }
    const block = { id: uid(), project, rangeStart, rangeEnd, owner, purpose, machine, reservedAt: nowISO() };
    reg.blocks.push(block);
    writeRegistry(reg);
    logEvents([...gcEvents(pruned), ev("block", { project, range: `${rangeStart}-${rangeEnd}`, owner: owner || undefined })]);
    return block;
  });
}

export async function releaseBlock(opts = {}) {
  const { id, project, machine } = opts;
  if (!id && !project) throw new Error("releaseBlock requires --id or --project");
  return withLock(async () => {
    const reg = readRegistry();
    const before = reg.blocks.length;
    // Same AND semantics as release(): match every supplied selector; `id` is global (machine-exempt).
    const hit = (b) => (!id || b.id === id) && (!project || b.project === project) && (!!id || !machine || b.machine === machine);
    const dropped = reg.blocks.filter(hit);
    reg.blocks = reg.blocks.filter((b) => !hit(b));
    writeRegistry(reg);
    logEvents(dropped.map((b) => ev("block-release", { project: b.project, range: `${b.rangeStart}-${b.rangeEnd}` })));
    return before - reg.blocks.length;
  });
}

export function listBlocks(opts = {}) {
  const reg = readRegistry();
  let rows = reg.blocks.slice().sort((a, b) => a.rangeStart - b.rangeStart);
  if (opts.project) rows = rows.filter((b) => b.project === opts.project);
  return rows;
}

// The block on `machine` (a missing block-machine matches) whose range spans `port`, else null.
export function blockAt(blocks, port, machine) {
  return blocks.find((b) => (b.machine || machine) === machine && b.rangeStart <= port && port <= b.rangeEnd) || null;
}

// ── Port REQUESTS: when a port you want is HELD, you ask through the ledger instead of clobbering.
// A request targets whatever holds the port (a reservation, else a block spanning it); the holder
// answers via resolveRequest. Grant on a reservation hands the port over immediately; grant on a
// block leaves the territory intact but issues a one-shot exemption reserve() honors (see above).
// Requests age out in reconcile() — they're conversation, not state worth keeping forever.
export async function requestPort(opts = {}) {
  const { port, fromProject, fromOwner = null, reason = null, machine = machineName() } = opts;
  if (!fromProject) throw new Error("request requires a --project (who is asking)");
  if (!validPort(port)) throw new Error(`invalid port ${port} — must be an integer 1-65535`);
  return withLock(async () => {
    const reg = readRegistry();
    const pruned = reconcile(reg); // prune first, like reserve(); audited after the persisting write
    const me = machineName();
    // Who holds the port on that machine? Machine-less rows/blocks are the registry HOST's — the
    // same normalization reserve() applies. A reservation outranks a block (it's the finer claim).
    const holder =
      reg.reservations.find((r) => (r.machine || me) === machine && r.port === port) ||
      reg.blocks.find((b) => (b.machine || me) === machine && b.rangeStart <= port && port <= b.rangeEnd);
    if (!holder) throw new Error(`nothing holds port ${port} on ${machine} — just reserve it`);
    if (holder.project === fromProject) throw new Error(`"${fromProject}" already holds port ${port} on ${machine} — no need to request it`);
    // Idempotent: re-filing the identical still-pending ask returns the existing row (a retrying
    // agent must not flood the holder's inbox). Matching the CURRENT holder too means a re-file after
    // the port changed hands files anew at the right door, instead of forever returning a stale ask
    // the new holder will never see (the old row ages out, or its target denies it).
    // The write persists what reconcile pruned.
    const dup = reg.requests.find((q) => q.status === "pending" && q.fromProject === fromProject &&
      q.port === port && q.targetProject === holder.project && (q.targetMachine || me) === machine);
    if (dup) { writeRegistry(reg); logEvents(gcEvents(pruned)); return dup; }
    // Cap pending asks per requester — a runaway agent can't wallpaper every inbox on the machine.
    const pending = reg.requests.filter((q) => q.status === "pending" && q.fromProject === fromProject);
    if (pending.length >= 32) throw new Error(`"${fromProject}" already has ${pending.length} pending requests — resolve some (or let them age out) first`);
    const req = {
      id: uid(), port, targetProject: holder.project, targetMachine: machine,
      fromProject, fromOwner, reason, status: "pending", note: null, consumed: false,
      createdAt: nowISO(), resolvedAt: null,
    };
    reg.requests.push(req);
    writeRegistry(reg);
    logEvents([...gcEvents(pruned), ev("request", { port, project: fromProject, target: holder.project, reason: reason || undefined })]);
    return req;
  });
}

// The asks awaiting `project`'s answer (every project's when omitted), scoped to one machine —
// port 5000 on another box is someone else's conversation. Read-only, like list().
export function inbox(opts = {}) {
  const { project = null, machine = machineName() } = opts;
  const reg = readRegistry();
  const me = machineName();
  return reg.requests.filter((q) =>
    q.status === "pending" && (!project || q.targetProject === project) && ((q.targetMachine || me) === machine));
}

// The requester's view: everything `fromProject` has filed, all statuses, newest first. Read-only.
export function outbox(opts = {}) {
  const { fromProject } = opts;
  if (!fromProject) throw new Error("outbox requires a --project (whose filings to show)");
  const reg = readRegistry();
  return reg.requests.filter((q) => q.fromProject === fromProject)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// The holder answers a pending request. DENY just marks it (the requester reads the verdict in
// outbox). GRANT releases the holder's reservation on that port in the SAME locked write, and until
// the requester reserves (consuming the grant) reserve() holds the port for them — no window for a
// third party to snipe it from the ledger (only an unmanaged OS bind could race them). If the holder
// was a BLOCK there's no reservation to release; the granted row itself becomes the one-shot
// exemption through the block that reserve() consumes.
export async function resolveRequest(opts = {}) {
  const { id, action, note = null } = opts;
  if (!id) throw new Error("resolve requires a request --id");
  if (action !== "grant" && action !== "deny") throw new Error(`invalid action "${action}" — must be "grant" or "deny"`);
  return withLock(async () => {
    const reg = readRegistry();
    const pruned = reconcile(reg); // audited after the persisting write below
    const req = reg.requests.find((q) => q.id === id);
    if (!req) throw new Error(`no request with id ${id} (it may have aged out)`);
    if (req.status !== "pending") throw new Error(`request ${id} is already ${req.status}`);
    req.status = action === "grant" ? "granted" : "denied";
    req.resolvedAt = nowISO();
    req.note = note;
    let releasedReservation = false;
    if (action === "grant") {
      // AND-scoped exactly like release(): port + holder project + machine — never another
      // project's hold on the same number, never the same project's hold on another machine.
      const me = machineName();
      const before = reg.reservations.length;
      reg.reservations = reg.reservations.filter((r) =>
        !(r.port === req.port && r.project === req.targetProject && (r.machine || me) === (req.targetMachine || me)));
      releasedReservation = reg.reservations.length < before;
    }
    writeRegistry(reg);
    logEvents([...gcEvents(pruned), ev(req.status === "granted" ? "grant" : "deny",
      { port: req.port, project: req.fromProject, target: req.targetProject, note: note || undefined, releasedReservation: releasedReservation || undefined })]);
    return { ...req, releasedReservation };
  });
}

export async function gc() {
  return withLock(async () => {
    const reg = readRegistry();
    const removed = reconcile(reg);
    const events = gcEvents(removed);
    // DEEP check, gc-only (it shells out — too slow for every reserve/list): PID REUSE. A local hold
    // whose pid is "alive" may be a new, unrelated process wearing the number. If we stamped the
    // original's start time at reserve, a mismatched current start time unmasks the impostor — the
    // real owner is dead, reclaim the hold. Unknown start times (either side) are never judged.
    const me = machineName();
    const suspects = reg.reservations.filter((r) => (!r.machine || r.machine === me) && r.pid && r.pidStartedAt);
    if (suspects.length) {
      touchLock(); // the batch start-time query can be slow (PowerShell) — heartbeat first
      const starts = await pidStartTimes([...new Set(suspects.map((r) => r.pid))]);
      const reused = new Set();
      for (const r of suspects) {
        const cur = starts.get(r.pid);
        // 5s slack absorbs etime's second-granularity and clock jitter; a REUSED pid differs by far more.
        if (cur != null && Math.abs(cur - r.pidStartedAt) > 5000) reused.add(r.id);
      }
      if (reused.size) {
        const gone = reg.reservations.filter((r) => reused.has(r.id));
        reg.reservations = reg.reservations.filter((r) => !reused.has(r.id));
        removed.push(...gone);
        events.push(...gone.map((r) => ev("gc", { port: r.port, project: r.project, owner: r.owner, pid: r.pid, reason: "pid-reused" })));
      }
    }
    writeRegistry(reg);
    logEvents(events);
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
  const me = machineName();
  // Only THIS machine's row (legacy machine-less rows are local) answers a local check — on a fleet
  // host the ledger holds other machines' rows too, and their ports don't collide with ours.
  const reservation = reg.reservations.find((r) => r.port === port && (!r.machine || r.machine === me)) || null;
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
// The state string is LOCALIZED ("ABHÖREN" on German Windows…), so "LISTENING" is only the fast path;
// the locale-proof tell is the foreign address — a TCP listener's is always 0.0.0.0:0 or [::]:0, while
// every other TCP state has a real foreign endpoint.
export function parseNetstat(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== "TCP") continue;
    if (!t.includes("LISTENING") && !/^(0\.0\.0\.0|\[::\]):0$/.test(t[2] || "")) continue;
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
// COMMAND may itself contain spaces ("Code Helper (Plugin)" → "Code Help" after lsof's 9-char cut),
// which shifts naive column splits — so anchor on the invariant tail (-sTCP:LISTEN means every data
// row ends `TCP <addr> (LISTEN)`), and read PID as the first integer token from the left with the
// command being everything before it.
export function parseLsof(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const m = line.match(/\sTCP\s+(\S+)\s+\(LISTEN\)\s*$/);
    if (!m) continue;
    const port = portOf(m[1]);
    const pm = line.match(/^\s*(.+?)\s+(\d+)\s+/); // command (may contain spaces), then the PID
    if (port && !out.has(port)) out.set(port, { port, pid: pm ? Number(pm[2]) : null, proc: pm ? pm[1] : null });
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
  const me = machineName();
  // Cross-reference only THIS machine's rows (legacy machine-less rows are local). On a fleet host the
  // ledger holds every machine's rows — a remote reservation must not label a local listener "managed",
  // and a live remote hold must never surface as a releasable local "ghost".
  const mine = reg.reservations.filter((r) => !r.machine || r.machine === me);
  const reserved = new Map(mine.map((r) => [r.port, r]));
  const listeners = await getListeners();
  // Fold in ports listening INSIDE running WSL distros (Windows; empty elsewhere): WSL2 shares the
  // host's effective localhost namespace, so they're real collision surface even when the host's own
  // listener table doesn't show a relay for them. Labeled `wsl:<distro>` so triage is obvious.
  const hostPorts = new Set(listeners.map((l) => l.port));
  for (const [port, distro] of await wslListenerPorts()) {
    if (!hostPorts.has(port)) listeners.push({ port, pid: null, proc: `wsl:${distro}` });
  }
  const seen = new Set();
  const managed = [], unmanaged = [];
  for (const l of listeners) {
    seen.add(l.port);
    const r = reserved.get(l.port);
    (r ? managed : unmanaged).push({ ...l, reservation: r || null });
  }
  const ghosts = mine.filter((r) => !seen.has(r.port));
  return { machine: me, listeners, managed, unmanaged, ghosts };
}

// ── Tailnet staging ORIGINS: a public `https://<magicdns-host>:<tsPort>` proxy fronting a local port,
// recorded against {project, localPort} so the one-origin-per-app mapping can't drift untracked. The
// tailscale serve side is driven by src/tailscale.js + bin; this is the pure ledger half (storage,
// idempotency, lookup, removal). Origins carry no PID/TTL — they're long-lived like blocks, never
// reconciled or gc'd. Conflicts are PER MACHINE, mirroring reservations/blocks (a machine-less origin
// is this machine's, the same normalization used elsewhere).

// Record (or idempotently refresh) a staging origin. Keyed on {machine, project, localPort}: re-exposing
// the same project's same local port UPDATES the existing row (new tsPort/url/host) instead of stacking
// duplicates — so `expose` is idempotent and re-running after a hostname/tsPort change self-heals.
// Throws if another PROJECT on this machine already serves the same tsPort (the dual-claim the whole
// feature exists to prevent).
export async function addOrigin(opts = {}) {
  const { project, localPort, tsPort, url, host = null, owner = null, purpose = null, machine = machineName() } = opts;
  if (!project) throw new Error("addOrigin requires a project");
  if (!validPort(localPort)) throw new Error(`invalid local port ${localPort} — must be an integer 1-65535`);
  if (!validPort(tsPort)) throw new Error(`invalid tailscale port ${tsPort} — must be an integer 1-65535`);
  if (!url) throw new Error("addOrigin requires a url");
  return withLock(async () => {
    const reg = readRegistry();
    const here = (m) => (m || machine) === machine; // machine-less origin == this machine
    // A given tsPort fronts exactly ONE origin per machine. If ANOTHER project already serves it, that's
    // the collision class — refuse loudly rather than silently retarget someone else's public URL.
    const clash = reg.origins.find((o) => here(o.machine) && o.tsPort === tsPort && o.project !== project);
    if (clash) throw new Error(`tailscale port ${tsPort} already fronts "${clash.project}" (${clash.url}) on ${machine} — pick another --https port`);
    const existing = reg.origins.find((o) => here(o.machine) && o.project === project && o.localPort === localPort);
    let origin;
    if (existing) {
      // Idempotent refresh: same {project, localPort} → update in place, preserving id/createdAt.
      Object.assign(existing, { tsPort, url, host, machine, owner: owner ?? existing.owner, purpose: purpose ?? existing.purpose, updatedAt: nowISO() });
      origin = existing;
    } else {
      origin = { id: uid(), project, localPort, tsPort, url, host, owner, purpose, machine, createdAt: nowISO(), updatedAt: nowISO() };
      reg.origins.push(origin);
    }
    writeRegistry(reg);
    logEvents([ev("expose", { port: localPort, tsPort, project, url })]);
    return origin;
  });
}

// Read-only: the staging origins matching the given selectors (ANDed exactly like release/originsFor's
// teardown). Used by bin BEFORE release() to learn which tsPorts need `tailscale serve … off`, and to
// confirm an origin exists. Omitting all selectors returns this machine's origins.
export function originsFor(opts = {}) {
  const { project, port, id, machine } = opts;
  const me = machineName();
  return readRegistry().origins.filter((o) =>
    (!id || o.id === id) &&
    (port == null || o.localPort === port) &&
    (!project || o.project === project) &&
    (!!id || (machine ? (o.machine || machine) === machine : (o.machine || me) === me)));
}

// Every recorded staging origin (this machine's; ?project= filters), sorted by local port. Read-only,
// like list()/listBlocks(). On a fleet host the ledger may hold other machines' origins — they're not
// this node's to manage, so a local listing scopes to this machine.
export function listOrigins(opts = {}) {
  const me = machineName();
  let rows = readRegistry().origins.filter((o) => (o.machine || me) === me).slice().sort((a, b) => a.localPort - b.localPort);
  if (opts.project) rows = rows.filter((o) => o.project === opts.project);
  return rows;
}

// Drop origin record(s) by the same ANDed selectors release() uses (without touching reservations) —
// the ledger half of teardown when the caller wants to remove an origin but keep the local port held.
// Returns the count removed.
export async function removeOrigin(opts = {}) {
  const { project, port, id, machine } = opts;
  if (port == null && !project && !id) throw new Error("removeOrigin requires a port, project, or id");
  return withLock(async () => {
    const reg = readRegistry();
    const before = reg.origins.length;
    const hit = (o) => (!id || o.id === id) && (port == null || o.localPort === port) && (!project || o.project === project) && (!!id || !machine || (o.machine || machine) === machine);
    const dropped = reg.origins.filter(hit);
    reg.origins = reg.origins.filter((o) => !hit(o));
    writeRegistry(reg);
    logEvents(dropped.map((o) => ev("origin-release", { port: o.localPort, tsPort: o.tsPort, project: o.project, url: o.url })));
    return before - reg.origins.length;
  });
}
