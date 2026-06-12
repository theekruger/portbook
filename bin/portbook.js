#!/usr/bin/env node
import { reserve, release, list, check, gc, scan, annotate, machineName, FILE, reserveBlock, releaseBlock, listBlocks, blockAt, requestPort, inbox, outbox, resolveRequest } from "../src/registry.js";
import { ecosystem } from "../src/environments.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
const num = (v) => (v == null || v === true ? undefined : Number(v)); // lenient — positionals only
// Strict numeric flags: garbage like `--ttl 30s` must fail loudly (exit 1), never silently become
// NaN — which downstream reads as "no ttl/pid", turning a crash-reclaimable hold into a permanent one.
function requireInt(name, v) {
  if (v === undefined) return undefined; // flag not given
  const n = v === true ? NaN : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${name}: ${v === true ? "missing value" : `"${v}"`} — must be a positive integer`);
  return n;
}

const HELP = `portbook — machine-wide port registry (so agents & servers stop colliding)

Usage:
  portbook reserve --project <name> [--port <p> | --count <n>] [--range <a-b>]
                   [--purpose "..."] [--owner <agent>] [--pid <pid>] [--ttl <seconds>] [--adopt] [--json]
  portbook release (--project <name> | --port <p> | --id <id>)
  portbook release (--block <id> | --project <name> --blocks)  # release reserved port block(s)
  portbook adopt <port> [--project <p>] [--owner <o>] [--purpose "..."]  # claim a running OS/external port
  portbook block --project <name> --range <a-b> [--owner <o>] [--purpose "..."]  # claim a port territory
  portbook block --project <name> | portbook blocks [--json]   # list reserved port blocks
  portbook request --port <p> --from <project> [--owner <o>] [--reason "..."] [--json]
                                                            # a port you need is HELD — ask, don't clobber
  portbook inbox [--project <p>] [--json]                   # pending requests against YOUR holds
  portbook requests --from <project> [--json]               # requests you filed, with verdicts (outbox)
  portbook grant <id> [--note "..."] [--json]               # hand the port over / exempt through your block
  portbook deny <id> [--note "..."] [--json]                # refuse it (your note lands in their outbox)
  portbook list [--project <name>] [--json] [--no-probe]    # reserved ports + live OS state
  portbook scan [--range <a-b>] [--json]                    # what's ACTUALLY listening on this machine
  portbook env [--json]                                     # full ecosystem: host + containers + WSL
  portbook serve [--port 7800] [--bind 127.0.0.1] [--open]  # live web dashboard (zero-dependency)
  portbook mcp                                              # MCP stdio server (JSON-RPC) for AI agent harnesses
  portbook check <port>                                     # is a port reserved and/or OS-free? (JSON)
  portbook gc                                               # reclaim dead-PID / expired reservations
  portbook fleet                                            # all machines' reservations (needs PORTBOOK_SERVER)
  portbook report                                           # push this machine's ecosystem to the fleet server
  portbook import [--json]                                  # migrate this machine's LOCAL reservations into the fleet server
  portbook where                                            # print the registry file path (or server URL in fleet mode)

Fleet mode: set PORTBOOK_SERVER=http://<host>:7800 and every ledger command (reserve, release, list,
check, gc, block/blocks, request/inbox/requests/grant/deny) coordinates against that shared server;
PORTBOOK_MACHINE overrides this machine's name. See docs/FLEET.md.

Examples:
  portbook reserve --project webapp --port 4100 --purpose "api origin" --owner claude
  PORT=$(portbook reserve --project api --count 1 --range 4200-4299)
  portbook block --project api --range 4200-4299            # claim a range; api's auto-picks land here
  portbook adopt 5432 --project postgres                    # register a service already on this port
  portbook request --port 5173 --from webapp --reason "vite default"   # negotiate for a held port
  portbook env                                              # containers labeled by name/image
  portbook serve --open                                     # open the dashboard in your browser
  portbook scan --range 4000-9000`;

function fmt(rows) {
  if (!rows.length) return "(no reservations)";
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const liveOf = (r) => (r.bound == null ? "?" : r.stale ? "stale" : r.bound ? "yes" : "no");
  // Show a MACHINE column only in genuine fleet mode: 2+ distinct *named* machines. Old reservations
  // without a `machine` field (undefined) don't count, so single-machine output stays unchanged.
  const multi = new Set(rows.map((r) => r.machine).filter(Boolean)).size > 1;
  const mcol = multi ? `${pad("MACHINE", 16)} ` : "";
  const mval = (r) => (multi ? `${pad((r.machine || "-").slice(0, 16), 16)} ` : "");
  const head = `${pad("PORT", 6)} ${mcol}${pad("PROJECT", 16)} ${pad("BOUND", 6)} ${pad("PID", 8)} ${pad("PURPOSE", 24)} OWNER`;
  const lines = rows.map(
    (r) => `${pad(r.port, 6)} ${mval(r)}${pad(r.project, 16)} ${pad(liveOf(r), 6)} ${pad(r.pid ?? "-", 8)} ${pad((r.purpose || "").slice(0, 24), 24)} ${r.owner || "-"}`
  );
  const stale = rows.filter((r) => r.stale).length;
  const ghosts = rows.filter((r) => r.bound === false && !r.stale).length;
  const notes = [];
  if (stale) notes.push(`${stale} stale (dead PID / expired) — run \`portbook gc\``);
  if (ghosts) notes.push(`${ghosts} reserved but nothing is listening — check \`portbook scan\``);
  return [head, ...lines, ...(notes.length ? ["", ...notes.map((n) => "• " + n)] : [])].join("\n");
}

// Render a block table (PROJECT, RANGE 'a–b', OWNER, PURPOSE) — MACHINE column only across machines.
function fmtBlocks(rows) {
  if (!rows.length) return "(no port blocks)";
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const multi = new Set(rows.map((b) => b.machine).filter(Boolean)).size > 1;
  const mcol = multi ? `${pad("MACHINE", 16)} ` : "";
  const mval = (b) => (multi ? `${pad((b.machine || "-").slice(0, 16), 16)} ` : "");
  const head = `${pad("PROJECT", 16)} ${mcol}${pad("RANGE", 13)} ${pad("OWNER", 12)} PURPOSE`;
  const lines = rows.map(
    (b) => `${pad(b.project, 16)} ${mval(b)}${pad(`${b.rangeStart}–${b.rangeEnd}`, 13)} ${pad((b.owner || "-").slice(0, 12), 12)} ${b.purpose || ""}`
  );
  return [head, ...lines].join("\n");
}

// Humanize how long ago an ISO timestamp was — the request tables show AGE, not raw dates.
function age(iso) {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "?";
  const v = Math.max(0, s);
  return v < 60 ? `${v}s` : v < 3600 ? `${Math.floor(v / 60)}m` : v < 86400 ? `${Math.floor(v / 3600)}h` : `${Math.floor(v / 86400)}d`;
}

// Render the holder's inbox: pending asks against your reservations/blocks. A TO column appears only
// when the asks target more than one project (same trick as fmt's MACHINE column).
function fmtInbox(rows) {
  if (!rows.length) return "(no pending requests)";
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const multi = new Set(rows.map((q) => q.targetProject)).size > 1;
  const tcol = multi ? `${pad("TO", 16)} ` : "";
  const tval = (q) => (multi ? `${pad(q.targetProject, 16)} ` : "");
  const head = `${pad("ID", 16)} ${pad("PORT", 6)} ${pad("FROM", 16)} ${tcol}${pad("REASON", 28)} AGE`;
  const lines = rows.map(
    (q) => `${pad(q.id, 16)} ${pad(q.port, 6)} ${pad(q.fromProject, 16)} ${tval(q)}${pad((q.reason || "-").slice(0, 28), 28)} ${age(q.createdAt)}`
  );
  return [head, ...lines, "", "• answer with `portbook grant <id>` or `portbook deny <id> [--note \"...\"]`"].join("\n");
}

// The requester's view: everything you filed, newest first, with the holder's verdict + note.
function fmtOutbox(rows) {
  if (!rows.length) return "(no requests filed)";
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const status = (q) => (q.status === "granted" && q.consumed ? "granted (claimed)" : q.status);
  const head = `${pad("ID", 16)} ${pad("PORT", 6)} ${pad("TO", 16)} ${pad("STATUS", 17)} ${pad("NOTE", 24)} AGE`;
  const lines = rows.map(
    (q) => `${pad(q.id, 16)} ${pad(q.port, 6)} ${pad(q.targetProject, 16)} ${pad(status(q), 17)} ${pad((q.note || "-").slice(0, 24), 24)} ${age(q.createdAt)}`
  );
  const ready = rows.filter((q) => q.status === "granted" && !q.consumed);
  const notes = ready.map((q) => `• port ${q.port} is granted and held for you — claim it: \`portbook reserve --project ${q.fromProject} --port ${q.port}\``);
  return [head, ...lines, ...(notes.length ? ["", ...notes] : [])].join("\n");
}

// Render `portbook fleet` — reservations grouped by machine + what each machine last reported.
function fmtFleet(f) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const byMachine = new Map();
  for (const r of f.reservations) { if (!byMachine.has(r.machine)) byMachine.set(r.machine, []); byMachine.get(r.machine).push(r); }
  const blocksByMachine = new Map();
  for (const b of (f.blocks || [])) { if (!blocksByMachine.has(b.machine)) blocksByMachine.set(b.machine, []); blocksByMachine.get(b.machine).push(b); }
  const reports = f.reports || {};
  const machines = [...new Set([...byMachine.keys(), ...blocksByMachine.keys(), ...Object.keys(reports)])].sort();
  const L = [`fleet server: ${f.server}    ${machines.length} machine(s)`, ""];
  if (!machines.length) return L.concat("(no machines yet — run `portbook report` / reserve from a client)").join("\n");
  for (const m of machines) {
    const rs = (byMachine.get(m) || []).sort((a, b) => a.port - b.port);
    const bs = (blocksByMachine.get(m) || []).sort((a, b) => a.rangeStart - b.rangeStart);
    const rep = reports[m];
    const repNote = rep ? ` — reported ${rep.ecosystem?.summary?.containers ?? 0} container(s) @ ${new Date(rep.at).toLocaleTimeString()}` : "";
    L.push(`${m}  (${rs.length} reservation(s), ${bs.length} block(s))${repNote}`);
    for (const b of bs) L.push(`  block ${pad(`${b.rangeStart}–${b.rangeEnd}`, 13)} ${b.project}${b.purpose ? ` — ${b.purpose}` : ""}`);
    for (const r of rs) L.push(`  ${pad(r.port, 6)} ${pad(r.project, 16)} ${r.purpose || ""}`);
  }
  return L.join("\n");
}

function fmtScan(res, inRange, blocks = []) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const byPort = (a, b) => a.port - b.port;
  // Tag a port with the block (on this machine) whose range owns it, if any.
  const blk = (port) => { const b = blockAt(blocks, port, res.machine); return b ? ` [block: ${b.project} ${b.rangeStart}–${b.rangeEnd}]` : ""; };
  const row = (port, pid, proc, tag) => `${pad(port, 6)} ${pad(pid ?? "-", 8)} ${pad((proc || "-").slice(0, 20), 20)} ${tag}${blk(port)}`;
  const managed = res.managed.filter((l) => inRange(l.port)).sort(byPort);
  const unmanaged = res.unmanaged.filter((l) => inRange(l.port)).sort(byPort);
  const ghosts = res.ghosts.filter((r) => inRange(r.port)).sort(byPort);
  const lines = [`machine: ${res.machine}`, ""];
  if (!res.listeners.length) {
    lines.push("(could not enumerate live listeners on this OS — showing registry only)", "");
  }
  lines.push(`LISTENING (${managed.length + unmanaged.length}) — ${managed.length} managed, ${unmanaged.length} unmanaged`);
  lines.push(`${pad("PORT", 6)} ${pad("PID", 8)} ${pad("PROCESS", 20)} STATUS`);
  for (const l of managed) lines.push(row(l.port, l.pid, l.proc, `managed → ${l.reservation.project}`));
  for (const l of unmanaged) lines.push(row(l.port, l.pid, l.proc, "UNMANAGED — not in portbook"));
  if (ghosts.length) {
    lines.push("", `GHOSTS (${ghosts.length}) — reserved but nothing is listening:`);
    for (const r of ghosts) lines.push(`${pad(r.port, 6)} ${pad(r.pid ?? "-", 8)} ${pad("-", 20)} reserved by ${r.project}${blk(r.port)}`);
  }
  return lines.join("\n");
}

// Strict `--range a-b`: both bounds must be positive integers (e.g. 4200-4299) — anything else exits 1.
function parseRange(v) {
  if (v === undefined) return [undefined, undefined];
  const m = typeof v === "string" ? v.match(/^(\d+)-(\d+)$/) : null;
  if (!m) throw new Error(`invalid --range: ${v === true ? "missing value" : `"${v}"`} — must be <start>-<end>, e.g. 4200-4299`);
  return [requireInt("--range start", m[1]), requireInt("--range end", m[2])];
}

function fmtEnv(e) {
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const rt = Object.keys(e.runtimes).filter((k) => e.runtimes[k]).join(", ") || "none detected";
  const s = e.summary;
  const L = [
    `machine: ${e.machine}    runtimes: ${rt}`,
    `${s.listening} listening — ${s.managed} managed, ${s.container} container, ${s.unmanaged} unmanaged · ${s.containers} container(s) · ${s.ghosts} ghost(s)`,
    "",
    `${pad("PORT", 6)} ${pad("WHAT", 30)} ${pad("RESERVATION", 16)} KIND`,
  ];
  for (const p of e.ports) {
    const what = p.container ? `${p.container.name} (${p.container.image})` : (p.proc || "-");
    L.push(`${pad(p.port, 6)} ${pad(what.slice(0, 30), 30)} ${pad(p.reservation ? p.reservation.project : "-", 16)} ${p.kind}`);
  }
  if (e.containers.length) {
    L.push("", "CONTAINERS:");
    for (const c of e.containers) {
      const maps = c.ports.map((p) => `${p.hostPort}->${p.containerPort}/${p.proto}`).join(", ") || "(no published ports)";
      const int = c.internalPorts.map((p) => `${p.containerPort}/${p.proto}`).join(", ");
      L.push(`  ${pad(c.name, 24)} ${pad(c.image, 22)} ${maps}${int ? `  [internal: ${int}]` : ""}`);
    }
  }
  if (e.wsl.length) {
    L.push("", "WSL DISTROS (ports inside need a reporter — fleet mode):");
    for (const d of e.wsl) L.push(`  ${pad(d.name, 24)} ${d.state} (WSL ${d.version})${d.default ? " *" : ""}`);
  }
  if (e.ghosts.length) {
    L.push("", "GHOSTS (reserved, not listening):");
    for (const g of e.ghosts) L.push(`  ${pad(g.port, 6)} ${g.project}${g.purpose ? ` — ${g.purpose}` : ""}`);
  }
  return L.join("\n");
}

function openBrowser(url) {
  const spec = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  import("node:child_process").then(({ spawn }) => { try { spawn(spec[0], spec[1], { detached: true, stdio: "ignore" }).unref(); } catch { /* best-effort */ } });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  // Fleet mode: when $PORTBOOK_SERVER is set, ledger ops (reserve/release/list/check/gc, blocks, and
  // the request flow) go to the shared server; scan/env/serve stay local (they describe THIS machine).
  // See docs/FLEET.md.
  const remote = process.env.PORTBOOK_SERVER ? await import("../src/client.js") : null;
  const reg = remote || { reserve, release, list, check, gc, reserveBlock, releaseBlock, listBlocks, requestPort, inbox, outbox, resolveRequest };
  try {
    if (!cmd || cmd === "help" || a.help) { console.log(HELP); return; }
    if (cmd === "where") { console.log(remote ? process.env.PORTBOOK_SERVER : FILE); return; }
    if (cmd === "reserve") {
      const [rangeStart, rangeEnd] = parseRange(a.range);
      const made = await reg.reserve({
        project: a.project, port: requireInt("--port", a.port), count: requireInt("--count", a.count) || 1,
        purpose: typeof a.purpose === "string" ? a.purpose : null,
        owner: typeof a.owner === "string" ? a.owner : null,
        pid: requireInt("--pid", a.pid), ttlSec: requireInt("--ttl", a.ttl), rangeStart, rangeEnd, adopt: !!a.adopt,
      });
      console.log(a.json ? JSON.stringify(made, null, 2) : made.map((m) => m.port).join("\n"));
      return;
    }
    if (cmd === "adopt") {
      // Claim a port already taken by an OS/external process. Default project to that process's name
      // (from scan()) and owner to "external" when the caller doesn't override either.
      const port = num(argv[1]) ?? requireInt("--port", a.port);
      if (!port) throw new Error("adopt requires a port, e.g. `portbook adopt 5432 --project postgres`");
      let project = typeof a.project === "string" ? a.project : null;
      if (!project) {
        const res = await scan();
        const hit = res.listeners.find((l) => l.port === port);
        project = (hit && hit.proc) || `port-${port}`;
      }
      const made = await reg.reserve({
        project, port, adopt: true,
        purpose: typeof a.purpose === "string" ? a.purpose : null,
        owner: typeof a.owner === "string" ? a.owner : "external",
        pid: requireInt("--pid", a.pid), ttlSec: requireInt("--ttl", a.ttl),
      });
      console.log(a.json ? JSON.stringify(made, null, 2) : made.map((m) => m.port).join("\n"));
      return;
    }
    if (cmd === "block") {
      if (a.range) {
        const [rangeStart, rangeEnd] = parseRange(a.range);
        const block = await reg.reserveBlock({
          project: a.project, rangeStart, rangeEnd,
          owner: typeof a.owner === "string" ? a.owner : null,
          purpose: typeof a.purpose === "string" ? a.purpose : null,
        });
        console.log(a.json ? JSON.stringify(block, null, 2) : fmtBlocks([block]));
        return;
      }
      const rows = await reg.listBlocks({ project: a.project }); // no --range → list this project's blocks
      console.log(a.json ? JSON.stringify(rows, null, 2) : fmtBlocks(rows));
      return;
    }
    if (cmd === "blocks") {
      const rows = await reg.listBlocks({ project: a.project });
      console.log(a.json ? JSON.stringify(rows, null, 2) : fmtBlocks(rows));
      return;
    }
    if (cmd === "release") {
      if (a.block || a.blocks) {
        const n = await reg.releaseBlock({ id: typeof a.block === "string" ? a.block : undefined, project: a.project });
        console.log(`released ${n} block(s)`);
        return;
      }
      const n = await reg.release({ project: a.project, port: requireInt("--port", a.port), id: a.id });
      console.log(`released ${n} reservation(s)`);
      return;
    }
    if (cmd === "request") {
      // A port you need is HELD (a reservation, or inside another project's block): ask through the
      // ledger instead of clobbering. --from is REQUIRED — a request needs an identity, or the holder
      // has no idea whose ask they'd be granting.
      const port = requireInt("--port", a.port) ?? num(a._[0]);
      if (!port) throw new Error("request requires --port, e.g. `portbook request --port 5173 --from webapp --reason \"vite default\"`");
      if (typeof a.from !== "string") throw new Error("request requires --from <project> — who is asking? The holder sees this in `portbook inbox`");
      const req = await reg.requestPort({
        port, fromProject: a.from,
        fromOwner: typeof a.owner === "string" ? a.owner : null,
        reason: typeof a.reason === "string" ? a.reason : null,
      });
      console.log(a.json ? JSON.stringify(req, null, 2)
        : `request ${req.id} (${req.status}): port ${req.port} asked of "${req.targetProject}" — verdict shows in \`portbook requests --from ${req.fromProject}\``);
      return;
    }
    if (cmd === "inbox") {
      const rows = await reg.inbox({ project: a.project }); // await: local inbox() is sync, remote is async
      console.log(a.json ? JSON.stringify(rows, null, 2) : fmtInbox(rows));
      return;
    }
    if (cmd === "requests") {
      if (typeof a.from !== "string") throw new Error("requests requires --from <project>, e.g. `portbook requests --from webapp`");
      const rows = await reg.outbox({ fromProject: a.from });
      console.log(a.json ? JSON.stringify(rows, null, 2) : fmtOutbox(rows));
      return;
    }
    if (cmd === "grant" || cmd === "deny") {
      const id = a._[0];
      if (!id) throw new Error(`${cmd} requires a request id, e.g. \`portbook ${cmd} <id>\` — ids are in \`portbook inbox\``);
      const res = await reg.resolveRequest({ id, action: cmd, note: typeof a.note === "string" ? a.note : null });
      if (a.json) { console.log(JSON.stringify(res, null, 2)); return; }
      console.log(cmd === "deny"
        ? `denied request ${res.id} — "${res.fromProject}" stays off port ${res.port}${res.note ? ` (note: ${res.note})` : ""}`
        : `granted request ${res.id}: port ${res.port} → "${res.fromProject}" — ` + (res.releasedReservation
            ? `released "${res.targetProject}"'s reservation; the port is held for them until they reserve it`
            : `issued a one-shot exemption through "${res.targetProject}"'s block (consumed when they reserve ${res.port})`));
      return;
    }
    if (cmd === "list") {
      const rows = await reg.list({ project: a.project }); // await: local list() is sync, remote is async
      const annotated = a["no-probe"] ? rows.map((r) => ({ ...r, bound: null, stale: null })) : await annotate(rows);
      // --json is ALWAYS a bare array of annotated reservation rows — a stable shape for the
      // documented `jq '.[] | …'` pipelines. Blocks have their own surface (`portbook blocks --json`);
      // the human output keeps its BLOCKS section below.
      if (a.json) { console.log(JSON.stringify(annotated, null, 2)); return; }
      const blocks = await reg.listBlocks({ project: a.project });
      const out = [fmt(annotated)];
      if (blocks.length) out.push("", "BLOCKS:", fmtBlocks(blocks));
      console.log(out.join("\n"));
      return;
    }
    if (cmd === "scan") {
      const [lo, hi] = parseRange(a.range);
      const res = await scan();
      if (a.json) { console.log(JSON.stringify(res, null, 2)); return; }
      const blocks = await reg.listBlocks({}); // annotate each port with its owning block (this machine)
      console.log(fmtScan(res, (p) => lo == null || (p >= lo && p <= hi), blocks));
      return;
    }
    if (cmd === "env" || cmd === "ecosystem") {
      const e = await ecosystem();
      console.log(a.json ? JSON.stringify(e, null, 2) : fmtEnv(e));
      return;
    }
    if (cmd === "serve") {
      const port = requireInt("--port", a.port) || 7800;
      const bind = typeof a.bind === "string" ? a.bind : "127.0.0.1";
      const { serve } = await import("../src/server.js");
      await serve({ port, bind });
      const shown = bind === "0.0.0.0" ? "localhost" : bind;
      console.log(`portbook dashboard → http://${shown}:${port}   (Ctrl-C to stop)${process.env.PORTBOOK_TOKEN ? "   · token auth ON" : ""}`);
      if (a.open) openBrowser(`http://${shown}:${port}`);
      return; // the http server keeps the process alive
    }
    if (cmd === "mcp") {
      const { runMcpServer } = await import("../src/mcp.js");
      await runMcpServer(); // speaks JSON-RPC over stdio; keeps the process alive until stdin ends
      return;
    }
    if (cmd === "check") {
      const port = num(argv[1]) ?? requireInt("--port", a.port);
      if (!port) throw new Error("check requires a port, e.g. `portbook check 4100`");
      console.log(JSON.stringify(await reg.check(port), null, 2));
      return;
    }
    if (cmd === "gc") { const removed = await reg.gc(); console.log(`reclaimed ${removed.length} stale reservation(s)`); return; }
    if (cmd === "report") {
      if (!remote) throw new Error("report needs a fleet server — set PORTBOOK_SERVER=http://<host>:7800");
      const eco = await remote.report();
      console.log(`reported ${machineName()} (${eco.summary.listening} ports, ${eco.summary.containers} containers) to ${process.env.PORTBOOK_SERVER}`);
      return;
    }
    if (cmd === "fleet") {
      if (!remote) throw new Error("fleet needs a fleet server — set PORTBOOK_SERVER=http://<host>:7800");
      const f = await remote.fleet();
      console.log(a.json ? JSON.stringify(f, null, 2) : fmtFleet(f));
      return;
    }
    if (cmd === "import") {
      if (!remote) throw new Error("import needs a fleet server — set PORTBOOK_SERVER=http://<host>:7800");
      // Read THIS machine's local reservations AND territory blocks (list()/listBlocks() always read the
      // local ~/.portbook file — the client is a separate module) and commit each to the shared server
      // verbatim. A per-port "already reserved on <machine>" conflict means it's already there → skip it,
      // don't abort.
      const local = list(); // local registry, regardless of $PORTBOOK_SERVER
      const imported = [], skipped = [];
      for (const r of local) {
        try { imported.push(await remote.importReservation(r)); }
        catch (e) { if (/already reserved on/.test(e?.message || "")) skipped.push(r); else throw e; }
      }
      // Blocks too: the core lets a project overlap its OWN block, so re-importing the same block would
      // duplicate it — dedupe against what the server already holds (same machine + project + range).
      // Key on the BLOCK's own machine (importBlock carries `b.machine || me`), not the current one,
      // so blocks recorded for another machine in a migrated registry stay idempotent across re-runs.
      const localBlocks = listBlocks();
      const onServer = localBlocks.length ? await reg.listBlocks({}) : [];
      const me = machineName();
      const present = (b) => { const bm = b.machine || me; return onServer.some((s) => (s.machine || me) === bm && s.project === b.project && s.rangeStart === b.rangeStart && s.rangeEnd === b.rangeEnd); };
      const blocksImported = [], blocksSkipped = [];
      for (const b of localBlocks) {
        if (present(b)) { blocksSkipped.push(b); continue; }
        try { blocksImported.push(await remote.importBlock(b)); }
        catch (e) { if (/overlaps|contains/.test(e?.message || "")) blocksSkipped.push(b); else throw e; }
      }
      const server = process.env.PORTBOOK_SERVER;
      if (a.json) console.log(JSON.stringify({ server, imported, skipped: skipped.length, blocksImported, blocksSkipped: blocksSkipped.length }, null, 2));
      else console.log(`imported ${imported.length} reservation(s) and ${blocksImported.length} block(s) to ${server} (skipped ${skipped.length} reservation(s), ${blocksSkipped.length} block(s) already present)`);
      return;
    }
    console.error(`unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exitCode = 1;
  } catch (e) {
    console.error("portbook: " + (e?.message || e));
    process.exitCode = 1;
  }
}
main();
