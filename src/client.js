// portbook fleet client — when $PORTBOOK_SERVER is set, the CLI/library talk to a shared `portbook
// serve` authority (one node on your Tailscale mesh) instead of the local file, so many machines
// coordinate against ONE registry. See docs/FLEET.md.
//
// The division of labor that makes this correct: the SERVER owns the ledger (and the machine-scoped
// conflict check); the CLIENT owns OS truth — only this machine can tell whether one of its own ports
// is free or its PID alive. So reserve/check/gc do their OS work here and commit to the server; the
// server never probes a port it can't see. Zero dependencies — Node's global fetch.
import { isPortFree, pidAlive, machineName } from "./registry.js";
import { ecosystem } from "./environments.js";

const base = () => {
  const s = (process.env.PORTBOOK_SERVER || "").replace(/\/+$/, "");
  if (!s) throw new Error("PORTBOOK_SERVER is not set");
  return s;
};

async function api(path, init) {
  // Send the bearer token when $PORTBOOK_TOKEN is set (required by a token-protected server).
  const headers = { ...(init && init.headers) };
  if (process.env.PORTBOOK_TOKEN) headers.authorization = `Bearer ${process.env.PORTBOOK_TOKEN}`;
  let res;
  try { res = await fetch(base() + path, { ...init, headers }); }
  catch (e) { throw new Error(`cannot reach portbook server at ${base()} (${e?.message || e})`); }
  const text = await res.text();
  let body, parsed = true; try { body = text ? JSON.parse(text) : {}; } catch { parsed = false; body = { error: text }; }
  if (!res.ok) throw new Error(body?.error || `portbook server returned ${res.status}`);
  if (!parsed) throw new Error(`portbook server returned a non-JSON response (${res.status}) — is ${base()} actually a portbook server?`);
  return body;
}
const get = (path) => api(path, {});
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

// Reserve against the shared registry. We resolve candidate ports HERE (OS-free check on this machine),
// then commit each to the server with probe:false so it trusts our local check and only enforces the
// machine-scoped ledger conflict.
export async function reserve(opts = {}) {
  const machine = machineName();
  if (!opts.project) throw new Error("reserve requires a --project");
  const host = opts.host || null;
  const adopt = !!opts.adopt;
  const port = opts.port != null ? Number(opts.port) : null;
  const count = opts.count || 1;
  const explicitRange = opts.rangeStart != null || opts.rangeEnd != null;
  const rangeStart = opts.rangeStart || 4000;
  const rangeEnd = opts.rangeEnd || 4999;

  // Commit one resolved port to the shared ledger. The server runs the authoritative machine-scoped
  // conflict check under its lock (probe:false — we already verified OS-freeness on this machine).
  const commit = async (p) => {
    const r = await post("/api/reserve", {
      project: opts.project, port: p, machine, probe: false, adopt,
      purpose: opts.purpose ?? null, owner: opts.owner ?? null, pid: opts.pid ?? null, ttlSec: opts.ttlSec ?? null, host,
    });
    return Array.isArray(r) ? r[0] : r;
  };
  // Ledger rejections auto-pick can retry past: someone on this machine grabbed the port between our
  // snapshot and the commit — as a reservation, as freshly claimed block territory, or as a port
  // mid-handover (granted to another project, unconsumed). The /api/list snapshot can't see promises
  // (the grant already released the holder's row), so the commit-time rejection IS the guard here —
  // mirroring the core auto-pick's `promised` skip, instead of aborting the whole batch.
  const isConflict = (e) => /already reserved on|is inside "[^"]*"'s reserved block|is granted to "/.test(e?.message || "");

  if (port != null) {
    if (!adopt && !(await isPortFree(port, host))) throw new Error(`port ${port} is in use on ${machine} at the OS level. Use --adopt if it's your own service.`);
    return [await commit(port)]; // a ledger conflict on a SPECIFIC port surfaces as-is (can't retry it)
  }

  // Auto-pick: the /api/list snapshot is only a hint; the per-port commit is the real guard. On a
  // ledger CONFLICT (a concurrent client on this machine grabbed it first) we advance to the next
  // free port — but never swallow an OS-busy/other error. This keeps concurrent auto-pick yielding
  // distinct ports, matching local single-machine behavior.
  const taken = new Set((await get("/api/list?raw=1")).filter((r) => r.machine === machine).map((r) => r.port));
  // Block-aware, mirroring the core: a FOREIGN block (another project's territory on THIS machine)
  // is always skipped; and absent an explicit range, hunt WITHIN this project's own block span(s)
  // (ascending) instead of the default 4000-4999. Your own block never blocks you. Machine-less rows
  // are LEGACY entries owned by the registry HOST (registry.js normalizes them with the server's own
  // name) — never this client's; if this client IS the host, the server's commit-time territory check
  // still rejects ("inside … reserved block"), which isConflict treats as a skippable conflict.
  const blocks = (await get("/api/blocks")).filter((b) => b.machine === machine);
  const foreignBlock = (p) => blocks.find((b) => b.project !== opts.project && b.rangeStart <= p && p <= b.rangeEnd);
  const own = !explicitRange
    ? blocks.filter((b) => b.project === opts.project).sort((a, b) => a.rangeStart - b.rangeStart)
    : [];
  const spans = own.length ? own.map((b) => [b.rangeStart, b.rangeEnd]) : [[rangeStart, rangeEnd]];
  const made = [];
  // Local reserve() is all-or-nothing (one write under one lock); the fleet path commits per port, so
  // any failure mid-batch must ROLL BACK the partial commits (best-effort, by global id) before
  // rethrowing — the caller must never be told "failed" while still holding ports in the shared ledger.
  const rollback = async () => { for (const m of made) await post("/api/release", { id: m.id }).catch(() => {}); };
  outer: for (const [lo, hi] of spans) {
    for (let p = lo; p <= hi && made.length < count; p++) {
      if (foreignBlock(p) || taken.has(p) || !(await isPortFree(p, host))) continue;
      try { made.push(await commit(p)); taken.add(p); }
      catch (e) { if (isConflict(e)) { taken.add(p); continue; } await rollback(); throw e; }
    }
    if (made.length >= count) break outer;
  }
  if (made.length < count) {
    await rollback();
    const where = own.length ? `"${opts.project}"'s block(s)` : `${rangeStart}-${rangeEnd}`;
    throw new Error(`could not find ${count} free port(s) in ${where} on ${machine}`);
  }
  return made;
}

// Release scoped to THIS machine (the server scopes port/project matches by the machine we pass; `id`
// is global). Returns the count released.
export async function release(opts = {}) {
  const body = (await post("/api/release", { ...opts, machine: machineName() }));
  return body.released ?? 0;
}

// Raw reservations from the shared registry (all machines). bin/the caller annotates locally so live
// `bound` reflects THIS machine's OS.
export async function list(opts = {}) {
  return get("/api/list?raw=1" + (opts.project ? `&project=${encodeURIComponent(opts.project)}` : ""));
}

// Check a port from THIS machine's point of view: its reservation in the shared registry (on this
// machine) and whether this machine's OS reports it free.
export async function check(port, host) {
  const machine = machineName();
  const reservation = (await get("/api/list?raw=1")).find((r) => r.port === port && r.machine === machine) || null;
  return { port, reservation, osFree: await isPortFree(port, host) };
}

// Reclaim THIS machine's stale holds (dead PID / expired TTL) from the shared registry — only we can
// judge our own PIDs, so the server can't do this for us.
export async function gc() {
  const machine = machineName();
  const t = Date.now();
  const removed = [];
  for (const r of (await get("/api/list?raw=1")).filter((r) => r.machine === machine)) {
    const expired = r.expiresAt && Date.parse(r.expiresAt) < t;
    const dead = r.pid && !pidAlive(r.pid);
    if (expired || dead) { await post("/api/release", { id: r.id }); removed.push(r); }
  }
  return removed;
}

// ── Port TERRITORY blocks against the shared ledger. The server owns the authoritative per-machine
// overlap check under its lock; the client just attaches THIS machine's identity. Blocks are
// persistent (no OS probe, no pid/ttl), so there's no client-side OS work — unlike reserve/gc.
export async function reserveBlock(opts = {}) {
  return post("/api/blocks", { ...opts, machine: machineName() });
}

// Release block(s) scoped to THIS machine (port/project matches); `id` is global. Returns the count.
export async function releaseBlock(opts = {}) {
  const body = await post("/api/blocks/release", { ...opts, machine: machineName() });
  return body.released ?? 0;
}

// Every territory block in the shared registry (all machines); ?project= filters server-side.
export async function listBlocks(opts = {}) {
  return get("/api/blocks" + (opts.project ? `?project=${encodeURIComponent(opts.project)}` : ""));
}

// Commit ONE pre-existing local block to the shared ledger verbatim (the block analogue of
// importReservation, used by `portbook import`). Carries the block's OWN machine (fallback
// machineName()) so a multi-machine registry migrates intact; the server still runs the per-machine
// overlap check, so an overlap rejection surfaces as-is for the caller to skip.
export async function importBlock(b) {
  return post("/api/blocks", {
    project: b.project, rangeStart: b.rangeStart, rangeEnd: b.rangeEnd,
    owner: b.owner ?? null, purpose: b.purpose ?? null, machine: b.machine || machineName(),
  });
}

// Commit ONE pre-existing local reservation to the shared ledger verbatim (used by `portbook import`).
// Unlike reserve(), this never auto-picks and never probes the OS: it migrates a record that already
// exists locally, so it carries the reservation's OWN machine (fallback machineName()) and preserves
// project/port/purpose/owner/pid. `adopt` follows the source status (an already-active hold re-registers
// as active). The server still runs the authoritative per-machine conflict check under its lock — a
// "already reserved on <machine>" rejection surfaces as-is for the caller to skip.
export async function importReservation(r) {
  const out = await post("/api/reserve", {
    project: r.project, port: r.port, machine: r.machine || machineName(),
    probe: false, adopt: r.status === "active",
    purpose: r.purpose ?? null, owner: r.owner ?? null, pid: r.pid ?? null,
  });
  return Array.isArray(out) ? out[0] : out;
}

// ── Port REQUESTS against the shared ledger (ask the holder instead of clobbering — see registry.js).
// The server resolves the holder and answers under its lock; the client only attaches THIS machine's
// identity wherever the core would default it to its own (which machine's port is being asked about;
// which box scopes the inbox). Same export names as the registry's, so bin's `reg` routing works.
export async function requestPort(opts = {}) {
  return post("/api/requests", { ...opts, machine: opts.machine || machineName() });
}

// The asks awaiting `project`'s answer on THIS machine (every project's when omitted).
export async function inbox(opts = {}) {
  return get(`/api/requests?machine=${encodeURIComponent(opts.machine || machineName())}` +
    (opts.project ? `&project=${encodeURIComponent(opts.project)}` : ""));
}

// The requester's view: everything `fromProject` has filed, all statuses, newest first (server-side).
export async function outbox(opts = {}) {
  if (!opts.fromProject) throw new Error("outbox requires a --project (whose filings to show)");
  return get(`/api/requests?from=${encodeURIComponent(opts.fromProject)}`);
}

// The holder answers a pending ask by id (global — no machine). A grant also releases the holder's
// reservation in the server's own locked write, so the handover is ledger-snipe-free (see registry.js).
export async function resolveRequest(opts = {}) {
  return post("/api/requests/resolve", opts);
}

// Push this machine's full ecosystem (host ports + containers + WSL) to the server so the fleet view /
// dashboard can show every machine — including what's inside it, which the server can't see itself.
export async function report() {
  const eco = await ecosystem();
  await post("/api/report", { machine: machineName(), ecosystem: eco });
  return eco;
}

// The whole fleet: every machine's reservations plus the latest ecosystem each machine reported.
export async function fleet() {
  return get("/api/fleet");
}
