// Fleet test — runs a `portbook serve` instance and the fleet client in ONE process, simulating two
// machines via $PORTBOOK_MACHINE, to verify shared reservations with PER-MACHINE conflict scoping,
// auto-pick, check, gc (expiry), report/fleet aggregation, and machine-scoped release — all over HTTP.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
