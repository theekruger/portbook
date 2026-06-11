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
    if (e.code === "ENOENT") return { version: 1, reservations: [], blocks: [] }; // no registry yet
    // EBUSY/EPERM/EACCES (AV / backup / sync tools) etc. — surface it. Returning "empty" here would
    // make the caller's next writeRegistry silently wipe the whole ledger.
    throw new Error(`cannot read registry ${FILE}: ${e.message}`);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a registry object");
    if (!Array.isArray(j.reservations)) j.reservations = [];
    if (!Array.isArray(j.blocks)) j.blocks = [];
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

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
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
  const explicitRange = opts.rangeStart != null || opts.rangeEnd != null;
  const rangeStart = opts.rangeStart || 4000;
  const rangeEnd = opts.rangeEnd || 4999;
  if (!project) throw new Error("reserve requires a --project");
  if (port != null && !validPort(port)) throw new Error(`invalid port ${port} — must be an integer 1-65535`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid --count ${count} — must be a positive integer`);
  return withLock(async () => {
    const reg = readRegistry();
    reconcile(reg);
    const me = machineName();
    const blocks = reg.blocks || [];
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
      const fb = foreignBlock(port);
      if (fb) throw new Error(`port ${port} is inside "${fb.project}"'s reserved block ${fb.rangeStart}-${fb.rangeEnd}`);
      // `adopt` registers a port you ALREADY run on (skips the free check). Otherwise it must be free.
      if (probe && !opts.adopt) {
        touchLock(); // heartbeat — a slow probe must not make us look crashed
        const pr = await probePort(port, host);
        if (!pr.free) {
          throw new Error(DENIED.has(pr.code)
            ? `port ${port} can't be bound on this OS (an excluded port range — on Windows see \`netsh interface ipv4 show excludedportrange protocol=tcp\` — or a privileged port). --adopt won't help: your server can't bind it either.`
            : `port ${port} is in use at the OS level. Use --adopt if this is your own running service.`);
        }
      }
      chosen.push(port);
    } else {
      // Auto-pick. If the caller didn't ask for an explicit range and this project owns block(s) on
      // this machine, hunt WITHIN its own territory (ascending) instead of the default 4000-4999.
      const own = !explicitRange
        ? blocks.filter((b) => (b.machine || me) === machine && b.project === project)
            .sort((a, b) => a.rangeStart - b.rangeStart)
        : [];
      const spans = own.length ? own.map((b) => [b.rangeStart, b.rangeEnd]) : [[rangeStart, rangeEnd]];
      let denied = 0; // ports the OS refuses to let ANYONE bind (excluded ranges / privileged)
      outer: for (const [lo, hi] of spans) {
        for (let p = lo; p <= hi && chosen.length < count; p++) {
          if (foreignBlock(p) || taken.has(key(p))) continue;
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
  // Supplied selectors are ANDed — a row goes only if it matches EVERY one — so `--project X --port P`
  // releases X's hold on P and never another project's P (a union would silently widen the blast
  // radius). When `machine` is given (fleet clients pass their own), port/project matches are scoped
  // to it so a client only releases its own holds; `id` is globally unique so it ignores the scope.
  const onMachine = (r) => !machine || r.machine === machine;
  return withLock(async () => {
    const reg = readRegistry();
    const before = reg.reservations.length;
    reg.reservations = reg.reservations.filter(
      (r) => !((!id || r.id === id) && (port == null || r.port === port) && (!project || r.project === project) && (!!id || onMachine(r)))
    );
    writeRegistry(reg);
    return before - reg.reservations.length;
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
    reconcile(reg);
    const here = (m) => (m || machine) === machine; // missing machine == this machine
    // IDEMPOTENT under the lock: re-claiming an IDENTICAL block (same project/machine/range) — a re-run
    // bootstrap, `portbook import`, or two agents racing — returns the existing row, never a duplicate.
    const dup = reg.blocks.find((b) => here(b.machine) && b.project === project && b.rangeStart === rangeStart && b.rangeEnd === rangeEnd);
    if (dup) { writeRegistry(reg); return dup; }
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
    reg.blocks = reg.blocks.filter(
      (b) => !((!id || b.id === id) && (!project || b.project === project) && (!!id || !machine || b.machine === machine))
    );
    writeRegistry(reg);
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
