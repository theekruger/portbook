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
  const isConflict = (e) => /already reserved on/.test(e?.message || "");

  if (port != null) {
    if (!adopt && !(await isPortFree(port, host))) throw new Error(`port ${port} is in use on ${machine} at the OS level. Use --adopt if it's your own service.`);
    return [await commit(port)]; // a ledger conflict on a SPECIFIC port surfaces as-is (can't retry it)
  }

  // Auto-pick: the /api/list snapshot is only a hint; the per-port commit is the real guard. On a
  // ledger CONFLICT (a concurrent client on this machine grabbed it first) we advance to the next
  // free port — but never swallow an OS-busy/other error. This keeps concurrent auto-pick yielding
  // distinct ports, matching local single-machine behavior.
  const taken = new Set((await get("/api/list?raw=1")).filter((r) => r.machine === machine).map((r) => r.port));
  const made = [];
  for (let p = rangeStart; p <= rangeEnd && made.length < count; p++) {
    if (taken.has(p) || !(await isPortFree(p, host))) continue;
    try { made.push(await commit(p)); taken.add(p); }
    catch (e) { if (isConflict(e)) { taken.add(p); continue; } throw e; }
  }
  if (made.length < count) throw new Error(`could not find ${count} free port(s) in ${rangeStart}-${rangeEnd} on ${machine}`);
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
