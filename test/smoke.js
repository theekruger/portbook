// Smoke test — exercises portbook against a throwaway registry dir and a genuinely-bound port.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

// A dev machine configured per docs/FLEET.md exports these — scrub them so the test is hermetic.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
const { reserve, list, release, check, isPortFree, probePort, annotate, scan, readRegistry, writeRegistry, FILE } =
  await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// A deterministically-bound port for the OS-level checks.
const srv = net.createServer().listen(0);
await new Promise((r) => srv.once("listening", r));
const busy = srv.address().port;

ok("isPortFree=false for a bound port", (await isPortFree(busy)) === false);

const made = await reserve({ project: "t", count: 1, owner: "smoke", rangeStart: 41000, rangeEnd: 41999 });
ok("reserve returns one free port", made.length === 1 && typeof made[0].port === "number");
ok("reserve stamps the machine", made[0].machine === os.hostname());
ok("registry lists it", list().length === 1);

let badPort = false; try { await reserve({ project: "t", port: 99999 }); } catch { badPort = true; }
ok("reserve rejects an out-of-range port", badPort);

let badCount = false; try { await reserve({ project: "t", count: 0 }); } catch { badCount = true; }
ok("reserve rejects a non-positive count", badCount);

let blocked = false; try { await reserve({ project: "t2", port: made[0].port }); } catch { blocked = true; }
ok("double-reserve is rejected", blocked);

let osBusy = false; try { await reserve({ project: "t3", port: busy }); } catch { osBusy = true; }
ok("reserve rejects an OS-busy port", osBusy);

const adopted = await reserve({ project: "t3", port: busy, adopt: true });
ok("adopt registers an in-use port", adopted.length === 1);

// annotate reflects live OS truth: the reserved-but-unbound port reads `bound:false`; the adopted
// genuinely-bound port reads `bound:true`.
const ann = await annotate(list());
ok("annotate flags a reserved-but-unbound port", ann.find((r) => r.port === made[0].port)?.bound === false);
ok("annotate sees a genuinely-bound port", ann.find((r) => r.port === busy)?.bound === true);

const sc = await scan();
ok("scan returns listener/managed/unmanaged/ghost arrays",
  Array.isArray(sc.listeners) && Array.isArray(sc.managed) && Array.isArray(sc.unmanaged) && Array.isArray(sc.ghosts));
ok("scan reports the unbound reservation as a ghost", sc.ghosts.some((r) => r.port === made[0].port));

ok("check finds reservation", (await check(made[0].port)).reservation?.project === "t");
ok("release removes by port", (await release({ port: made[0].port })) === 1);

// ── machine-aware conflicts & cross-references ────────────────────────────────────────────────────
// (a) LEGACY rows (pre-fleet, no .machine) belong to THIS machine: they must block a re-reserve and
// show up in local views, instead of keying as "undefined:<port>" and being invisible.
{
  const reg = readRegistry();
  reg.reservations.push({ id: "legacy1", port: 43210, project: "legacy-app", purpose: null, owner: null,
    pid: null, host: "*", status: "reserved", reservedAt: new Date().toISOString(), expiresAt: null }); // no machine
  writeRegistry(reg);
}
let legacyClash = false; try { await reserve({ project: "newcomer", port: 43210, adopt: true }); } catch { legacyClash = true; }
ok("machine-less legacy reservation blocks a local re-reserve", legacyClash);
ok("check treats a machine-less row as local", (await check(43210)).reservation?.project === "legacy-app");
ok("scan reports the legacy row as a local ghost", (await scan()).ghosts.some((r) => r.port === 43210));

// (b) REMOTE rows (a fleet host's ledger holds every machine's rows) must not pollute local views:
// not check()'s answer, and never a releasable local "ghost".
await reserve({ project: "remote-proj", port: 43300, machine: "some-other-box", probe: false });
ok("check ignores another machine's reservation", (await check(43300)).reservation === null);
ok("scan does not report a remote hold as a local ghost", !(await scan()).ghosts.some((r) => r.port === 43300));
process.env.PORTBOOK_MACHINE = "logical-name"; // scan()'s machine field must honor the override
ok("scan.machine honors PORTBOOK_MACHINE", (await scan()).machine === "logical-name");
delete process.env.PORTBOOK_MACHINE;
// A local listener whose port only a REMOTE row holds must read unmanaged — not "managed → remote".
const srv2 = net.createServer().listen(0);
await new Promise((r) => srv2.once("listening", r));
const busy2 = srv2.address().port;
await reserve({ project: "remote-proj2", port: busy2, machine: "some-other-box", probe: false });
const sc2 = await scan();
ok("local listener with only a remote-machine row reads unmanaged",
  sc2.unmanaged.some((l) => l.port === busy2) && !sc2.managed.some((l) => l.port === busy2));
srv2.close();
await release({ port: busy2 });

// ── release() ANDs its selectors ──────────────────────────────────────────────────────────────────
await reserve({ project: "webapp", port: 43401, adopt: true });
await reserve({ project: "webapp", port: 43402, adopt: true });
await reserve({ project: "postgres", port: 43403, adopt: true });
ok("release(project+port) of a non-matching pair releases NOTHING", (await release({ project: "webapp", port: 43403 })) === 0);
ok("release(project+port) hits exactly that project's hold", (await release({ project: "webapp", port: 43401 })) === 1);
ok("release(project) sweeps the project's remaining holds", (await release({ project: "webapp" })) === 1);
ok("release(port) alone still works", (await release({ port: 43403 })) === 1);

// ── probePort preserves the OS failure code (EADDRINUSE = busy; EACCES/EPERM = OS-excluded) ──────
const pr = await probePort(busy);
ok("probePort reports a bound port as EADDRINUSE", pr.free === false && pr.code === "EADDRINUSE");
ok("probePort reports a free port as free", (await probePort(43999)).free === true);

// ── a corrupt ledger is QUARANTINED, never silently wiped (run last — it nukes the registry) ─────
fs.writeFileSync(FILE, "{ definitely not json");
let corrupt = false; try { await reserve({ project: "x", port: 43500, adopt: true }); } catch { corrupt = true; }
ok("mutating over a corrupt registry throws", corrupt);
const quarantined = fs.readdirSync(process.env.PORTBOOK_DIR).filter((f) => f.startsWith("registry.json.corrupt-"));
ok("corrupt ledger bytes are quarantined intact",
  quarantined.length === 1 && fs.readFileSync(path.join(process.env.PORTBOOK_DIR, quarantined[0]), "utf8") === "{ definitely not json");
ok("corrupt file was moved aside, not overwritten in place", !fs.existsSync(FILE));

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
