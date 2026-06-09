// Import test — `portbook import` migrates THIS machine's LOCAL reservations into a shared fleet
// server. registry.js binds its FILE from $PORTBOOK_DIR at import time, so one process = one store;
// to exercise a genuine local→server hop we run the server as a SUBPROCESS with its OWN PORTBOOK_DIR,
// while this process keeps the LOCAL store. We seed a couple of local reservations, run the import
// (local list() + client.importReservation, the exact path bin/portbook.js uses), then read the
// server back and assert they arrived — and that a second run skips them (per-machine conflict).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "bin", "portbook.js");

const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-import-local-"));
const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-import-server-"));

// This process IS the "local" machine: bind its registry to localDir BEFORE importing registry.js.
process.env.PORTBOOK_DIR = localDir;
const registry = await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pick a free high port for the server, then spawn it with its OWN store (serverDir) so the server's
// ledger is genuinely separate from this process's local one.
const SERVER_PORT = await registry.reserve({ project: "_srv", count: 1, rangeStart: 47600, rangeEnd: 47699 })
  .then((m) => m[0].port);
await registry.release({ project: "_srv" }); // free it again; the child binds it for real

const child = spawn(process.execPath, [CLI, "serve", "--port", String(SERVER_PORT)], {
  env: { ...process.env, PORTBOOK_DIR: serverDir, PORTBOOK_SERVER: "" }, // child must NOT inherit fleet mode
  stdio: "ignore",
});
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;

// Poll the server until /api/list answers (or give up after ~5s).
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(SERVER + "/api/list?raw=1"); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(50);
  }
  return false;
}

async function run() {
  ok("server subprocess came up", await waitForServer());

  // Seed two LOCAL reservations on free high ports (adopt:true → no OS bind needed, registers verbatim).
  const seedA = (await registry.reserve({ project: "alpha", port: 47710, adopt: true, purpose: "api", owner: "smoke" }))[0];
  const seedB = (await registry.reserve({ project: "beta", port: 47711, adopt: true }))[0];
  ok("two local reservations seeded", registry.list().length === 2 && seedA.port === 47710 && seedB.port === 47711);

  // Enter fleet mode and run the import loop exactly as the CLI does: local list() + importReservation,
  // skipping per-port conflicts.
  process.env.PORTBOOK_SERVER = SERVER;
  const client = await import("../src/client.js");
  const doImport = async () => {
    const imported = [], skipped = [];
    for (const r of registry.list()) {
      try { imported.push(await client.importReservation(r)); }
      catch (e) { if (/already reserved on/.test(e?.message || "")) skipped.push(r); else throw e; }
    }
    return { imported, skipped };
  };

  const first = await doImport();
  ok("first import reports 2 imported, 0 skipped", first.imported.length === 2 && first.skipped.length === 0);

  // Read the SERVER back and confirm both reservations arrived with fields preserved.
  const onServer = await (await fetch(SERVER + "/api/list?raw=1")).json();
  const byPort = (p) => onServer.find((r) => r.port === p);
  ok("server now holds both reservations", onServer.length === 2);
  ok("alpha arrived with project/purpose/owner preserved",
    byPort(47710)?.project === "alpha" && byPort(47710)?.purpose === "api" && byPort(47710)?.owner === "smoke");
  ok("imported reservations carry this machine's name",
    byPort(47710)?.machine === registry.machineName() && byPort(47711)?.machine === registry.machineName());
  ok("an adopted (active) source registers active on the server", byPort(47710)?.status === "active");

  // A second import is idempotent: same machine + same ports → per-machine conflict → all skipped.
  const second = await doImport();
  ok("re-run skips both (already present), imports nothing", second.imported.length === 0 && second.skipped.length === 2);
  ok("server still holds exactly 2 (no duplicates)", (await (await fetch(SERVER + "/api/list?raw=1")).json()).length === 2);

  // The CLI guards fleet mode: without PORTBOOK_SERVER, `portbook import` must error clearly.
  const noFleet = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "import"], { env: { ...process.env, PORTBOOK_SERVER: "" } });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, err }));
  });
  ok("import without a fleet server exits non-zero with a clear message",
    noFleet.code === 1 && /import needs a fleet server/.test(noFleet.err));
}

try { await run(); }
catch (e) { fail++; console.log("  FAIL unexpected error: " + (e?.stack || e)); }
finally {
  try { child.kill(); } catch { /* already gone */ }
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.rmSync(serverDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
