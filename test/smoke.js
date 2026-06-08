// Smoke test — exercises portbook against a throwaway registry dir and a genuinely-bound port.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
const { reserve, list, release, check, isPortFree, annotate, scan } = await import("../src/registry.js");

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

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
