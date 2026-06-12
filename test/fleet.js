// Fleet test — runs a `portbook serve` instance and the fleet client in ONE process, simulating two
// machines via $PORTBOOK_MACHINE, to verify shared reservations with PER-MACHINE conflict scoping,
// auto-pick, check, gc (expiry), report/fleet aggregation, and machine-scoped release — all over HTTP.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Never inherit fleet config from the host machine — docs/FLEET.md tells users to export these in
// their shell profile, which used to turn this suite red. The test sets its own values explicitly.
// The TTL/staleness knobs are scrubbed too: a stray tiny PORTBOOK_REPORT_TTL_MS would age reports out
// of the main server mid-suite, and a tiny request TTL would evaporate the asks the negotiation
// flow below asserts on.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE", "PORTBOOK_REPORT_TTL_MS",
  "PORTBOOK_REQUEST_TTL_MS", "PORTBOOK_REQUEST_PENDING_TTL_MS", "PORTBOOK_LOCK_STALE_MS"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-fleet-test-"));
const { createServer } = await import("../src/server.js");
const client = await import("../src/client.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const asMachine = (m) => { process.env.PORTBOOK_MACHINE = m; };

const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.PORTBOOK_SERVER = `http://127.0.0.1:${srv.address().port}`;

asMachine("alpha");
const a1 = await client.reserve({ project: "a", port: 45000, adopt: true });
ok("alpha reserves 45000 on the shared server", a1.length === 1 && a1[0].port === 45000 && a1[0].machine === "alpha");

asMachine("beta");
const b1 = await client.reserve({ project: "b", port: 45000, adopt: true });
ok("beta reserves the SAME port 45000 (per-machine — no conflict)", b1.length === 1 && b1[0].machine === "beta");

asMachine("alpha");
let blocked = false; try { await client.reserve({ project: "a2", port: 45000, adopt: true }); } catch { blocked = true; }
ok("same machine + same port is rejected", blocked);

const all = await client.list();
ok("shared list shows both machines holding 45000", all.filter((r) => r.port === 45000).length === 2);

const auto = await client.reserve({ project: "a", count: 1, rangeStart: 46000, rangeEnd: 46050 });
ok("auto-pick reserves a genuinely-free port in range", auto.length === 1 && auto[0].port >= 46000 && auto[0].port <= 46050);

const c = await client.check(45000);
ok("check sees this machine's (alpha) reservation on 45000", c.reservation?.project === "a" && c.reservation?.machine === "alpha");

asMachine("beta");
await client.report();
const f = await client.fleet();
ok("fleet aggregates both machines' reservations", new Set(f.reservations.map((r) => r.machine)).size === 2);
ok("fleet includes beta's reported ecosystem", !!f.reports.beta && Array.isArray(f.reports.beta.ecosystem.ports));

asMachine("alpha");
await client.reserve({ project: "a", port: 45001, adopt: true, ttlSec: -1 }); // already-expired hold
const removed = await client.gc();
ok("gc reclaims this machine's expired hold", removed.some((r) => r.port === 45001));

asMachine("beta");
const rel = await client.release({ port: 45000 });
ok("release is scoped to beta (removes only beta's 45000)", rel === 1);
const after = await client.list();
ok("alpha's 45000 survives beta's release", after.filter((r) => r.port === 45000 && r.machine === "alpha").length === 1);

// Concurrent auto-pick on the SAME machine must hand out DISTINCT ports (retry-on-ledger-conflict),
// not collapse to a single winner. Run last — it introduces a third machine, "gamma".
asMachine("gamma");
const concurrent = await Promise.all(Array.from({ length: 5 }, () => client.reserve({ project: "g", count: 1, rangeStart: 47000, rangeEnd: 47050 })));
ok("concurrent same-machine auto-pick yields 5 distinct ports", new Set(concurrent.flat().map((r) => r.port)).size === 5);

// A multi-port reserve that fails mid-batch must ROLL BACK its partial commits (local reserve is
// all-or-nothing; the fleet path mirrors that) — never "failed" while still holding ports.
asMachine("delta");
let short = null; try { await client.reserve({ project: "partial", count: 3, rangeStart: 48750, rangeEnd: 48751 }); } catch (e) { short = e; }
ok("multi-port reserve in a too-small range throws", /could not find 3 free port/.test(short?.message || ""));
ok("…and rolls back its partial commits (nothing stranded)", (await client.list({ project: "partial" })).length === 0);

// Territory claimed AFTER the client's blocks snapshot surfaces as a commit-time rejection; auto-pick
// must skip past it like a reserved-port conflict, not abort. Simulate the race deterministically by
// blinding ONE /api/blocks snapshot (redirect it to a project with no blocks).
await client.reserveBlock({ project: "terra", rangeStart: 47100, rangeEnd: 47102 });
const realFetch = globalThis.fetch;
globalThis.fetch = (u, i) => {
  if (String(u).endsWith("/api/blocks") && !(i && i.method)) { globalThis.fetch = realFetch; return realFetch(u + "?project=__none__", i); }
  return realFetch(u, i);
};
let roam = [];
try { roam = await client.reserve({ project: "roamer", count: 1, rangeStart: 47100, rangeEnd: 47110 }); } catch {} finally { globalThis.fetch = realFetch; }
ok("auto-pick advances past territory claimed after its snapshot", roam.length === 1 && roam[0].port >= 47103);

// ── Request/inbox negotiation over HTTP — same machine, DIFFERENT project (the only pairing where a
// hold actually contends: per-machine scoping means beta wanting beta's 45100 never met alpha's hold).
// "web" holds 45100 on alpha; "agent7" (also alpha) asks; web grants — which releases its hold in the
// same locked write and leaves the port PROMISED to agent7 until agent7 reserves (consuming the grant).
asMachine("alpha");
await client.reserve({ project: "web", port: 45100, adopt: true });
const ask = await client.requestPort({ port: 45100, fromProject: "agent7", reason: "wants web's dev port" });
ok("requestPort files a pending ask against the holder", ask.status === "pending" && ask.targetProject === "web" && ask.targetMachine === "alpha");

let early = false; try { await client.reserve({ project: "agent7", port: 45100, adopt: true }); } catch { early = true; }
ok("the asked-for port stays the holder's until granted", early);

const inb = await client.inbox({ project: "web" });
ok("web's inbox on alpha sees the ask", inb.length === 1 && inb[0].id === ask.id && inb[0].fromProject === "agent7");

asMachine("beta");
ok("the inbox is machine-scoped — the same query from beta is empty", (await client.inbox({ project: "web" })).length === 0);

asMachine("alpha");
const verdict = await client.resolveRequest({ id: ask.id, action: "grant", note: "take it" });
ok("grant resolves the ask and releases web's hold in the same write", verdict.status === "granted" && verdict.releasedReservation === true);

let sniped = null; try { await client.reserve({ project: "snoop", port: 45100, adopt: true }); } catch (e) { sniped = e; }
ok("granted-but-unconsumed port is promised — a third party is refused", /granted to "agent7"/.test(sniped?.message || ""));

const got = await client.reserve({ project: "agent7", port: 45100, adopt: true });
ok("the grantee reserves the promised port", got.length === 1 && got[0].port === 45100 && got[0].project === "agent7" && got[0].machine === "alpha");
ok("the handover is complete — web no longer holds 45100", (await client.list({ project: "web" })).every((r) => r.port !== 45100));

const out = await client.outbox({ fromProject: "agent7" });
ok("agent7's outbox shows the granted verdict + note", out.some((q) => q.id === ask.id && q.status === "granted" && q.note === "take it"));

// Deny is the other half of the lifecycle: snoop now asks agent7 for the port it just won; agent7 says no.
const ask2 = await client.requestPort({ port: 45100, fromProject: "snoop" });
await client.resolveRequest({ id: ask2.id, action: "deny", note: "still using it" });
const out2 = await client.outbox({ fromProject: "snoop" });
ok("deny marks the ask; the requester reads the verdict in outbox", out2[0]?.status === "denied" && out2[0]?.note === "still using it");
ok("…and the holder keeps the port", (await client.list({ project: "agent7" })).some((r) => r.port === 45100));

// Auto-pick must SKIP a port mid-handover (granted, unconsumed): the snapshot can't see the promise
// (the grant already released the holder's row), so the commit-time "granted to" rejection must
// advance to the next port — mirroring the core auto-pick's promised-port guard — not abort the batch.
await client.reserve({ project: "holder", port: 47200, adopt: true });
const ask3 = await client.requestPort({ port: 47200, fromProject: "wantit" });
await client.resolveRequest({ id: ask3.id, action: "grant" });
let drift = [];
try { drift = await client.reserve({ project: "drifter", count: 1, rangeStart: 47200, rangeEnd: 47210 }); } catch {}
ok("auto-pick advances past a promised (granted, unconsumed) port", drift.length === 1 && drift[0].port > 47200 && drift[0].port <= 47210);
const claimed = await client.reserve({ project: "wantit", port: 47200, adopt: true });
ok("…leaving the promise intact for the grantee to claim", claimed.length === 1 && claimed[0].port === 47200);

// The reports map is bounded: client-controlled keys can't grow it past 256 machines (stalest report
// evicted first — beta's earlier report is the oldest), and junk keys are ignored.
const SERVER = process.env.PORTBOOK_SERVER;
await fetch(SERVER + "/api/report", { method: "POST", body: JSON.stringify({ machine: { sneaky: 1 } }) });
for (let i = 0; i < 260; i++) await fetch(SERVER + "/api/report", { method: "POST", body: JSON.stringify({ machine: "m" + i }) });
const names = Object.keys((await client.fleet()).reports);
ok("reports map is capped at 256 machines", names.length <= 256);
ok("cap evicts stalest-first (newest kept, first-seen gone)", names.includes("m259") && !names.includes("m0") && !names.includes("beta"));
ok("non-string machine names are ignored", !names.some((n) => n.includes("object")));

// Machines that stop reporting age out after the TTL (PORTBOOK_REPORT_TTL_MS is a test knob; 24h default).
process.env.PORTBOOK_REPORT_TTL_MS = "60";
const ttlSrv = createServer();
delete process.env.PORTBOOK_REPORT_TTL_MS;
await new Promise((r) => ttlSrv.listen(0, "127.0.0.1", r));
const tbase = `http://127.0.0.1:${ttlSrv.address().port}`;
await fetch(tbase + "/api/report", { method: "POST", body: JSON.stringify({ machine: "gone" }) });
await new Promise((r) => setTimeout(r, 150));
const tf = await (await fetch(tbase + "/api/fleet")).json();
ok("reports older than the TTL age out of the fleet view", !tf.reports.gone);
ttlSrv.close();

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
