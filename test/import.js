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

// Tests must not inherit fleet config (docs/FLEET.md tells users to export these in the profile);
// scrub BEFORE importing src modules — a leaked PORTBOOK_TOKEN would 401 the raw fetches below.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
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
  env: { ...process.env, PORTBOOK_DIR: serverDir, PORTBOOK_SERVER: "", PORTBOOK_TOKEN: "" }, // child must NOT inherit fleet mode or auth
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

// Spawn the CLI against the LOCAL store (no fleet), capturing exit code + stdout/stderr.
const runCli = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PORTBOOK_SERVER: "" } });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => resolve({ code, out, err }));
});

async function run() {
  ok("server subprocess came up", await waitForServer());

  // Seed two LOCAL reservations on free high ports (adopt:true → no OS bind needed, registers verbatim).
  const seedA = (await registry.reserve({ project: "alpha", port: 47710, adopt: true, purpose: "api", owner: "smoke" }))[0];
  const seedB = (await registry.reserve({ project: "beta", port: 47711, adopt: true }))[0];
  ok("two local reservations seeded", registry.list().length === 2 && seedA.port === 47710 && seedB.port === 47711);

  // Seed a LOCAL territory block too — this is the part `portbook import` used to silently drop.
  const seedBlock = await registry.reserveBlock({ project: "alpha", rangeStart: 47720, rangeEnd: 47729, owner: "smoke", purpose: "territory" });
  ok("a local territory block seeded", registry.listBlocks().length === 1 && seedBlock.rangeStart === 47720 && seedBlock.rangeEnd === 47729);

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
    // Blocks too — mirror bin/portbook.js's import branch: dedupe against the server, skip overlap/contains.
    // The dedupe keys on the BLOCK's own machine (importBlock carries `b.machine || me`), so blocks
    // recorded for another machine stay idempotent too.
    const localBlocks = registry.listBlocks();
    const onServerBlocks = localBlocks.length ? await client.listBlocks({}) : [];
    const me = registry.machineName();
    const present = (b) => { const bm = b.machine || me; return onServerBlocks.some((s) => (s.machine || me) === bm && s.project === b.project && s.rangeStart === b.rangeStart && s.rangeEnd === b.rangeEnd); };
    const blocksImported = [], blocksSkipped = [];
    for (const b of localBlocks) {
      if (present(b)) { blocksSkipped.push(b); continue; }
      try { blocksImported.push(await client.importBlock(b)); }
      catch (e) { if (/overlaps|contains/.test(e?.message || "")) blocksSkipped.push(b); else throw e; }
    }
    return { imported, skipped, blocksImported, blocksSkipped };
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

  // The block migrated too (the bug this test guards against): it must arrive on the server.
  ok("first import also migrated the territory block", first.blocksImported.length === 1 && first.blocksSkipped.length === 0);
  const serverBlocks = await (await fetch(SERVER + "/api/blocks")).json();
  ok("server now holds the block with fields + machine preserved",
    serverBlocks.length === 1 && serverBlocks[0].project === "alpha" &&
    serverBlocks[0].rangeStart === 47720 && serverBlocks[0].rangeEnd === 47729 &&
    serverBlocks[0].machine === registry.machineName());

  // A second import is idempotent: same machine + same ports → per-machine conflict → all skipped.
  const second = await doImport();
  ok("re-run skips both (already present), imports nothing", second.imported.length === 0 && second.skipped.length === 2);
  ok("server still holds exactly 2 (no duplicates)", (await (await fetch(SERVER + "/api/list?raw=1")).json()).length === 2);
  ok("re-run skips the block too (idempotent)", second.blocksImported.length === 0 && second.blocksSkipped.length === 1);
  ok("server still holds exactly 1 block (no duplicates)", (await (await fetch(SERVER + "/api/blocks")).json()).length === 1);

  // A block recorded for ANOTHER machine (a migrated multi-machine registry) must import once and
  // then dedupe on re-runs — the old present() keyed on the CURRENT machine, so foreign blocks
  // re-imported as duplicates on every run.
  await registry.reserveBlock({ project: "gamma", rangeStart: 47740, rangeEnd: 47749, machine: "other-machine" });
  const third = await doImport();
  ok("a foreign-machine block imports once, machine preserved",
    third.blocksImported.length === 1 && third.blocksImported[0].machine === "other-machine" && third.blocksSkipped.length === 1);
  const fourth = await doImport();
  ok("re-run skips the foreign-machine block too (idempotent)", fourth.blocksImported.length === 0 && fourth.blocksSkipped.length === 2);
  ok("server holds exactly 2 blocks (no foreign duplicates)", (await (await fetch(SERVER + "/api/blocks")).json()).length === 2);

  // ── Strict numeric flags: garbage --ttl/--pid/--port/--count/--range must exit 1 loudly. The old
  // num() yielded NaN, silently writing a PERMANENT hold (pid/expiresAt null) — defeating crash reclaim.
  const flagCases = [
    [["reserve", "--project", "x", "--port", "47750", "--ttl", "30s"], /invalid --ttl/],
    [["reserve", "--project", "x", "--port", "47750", "--pid", "abc"], /invalid --pid/],
    [["reserve", "--project", "x", "--port", "12x"], /invalid --port/],
    [["reserve", "--project", "x", "--count", "two"], /invalid --count/],
    [["reserve", "--project", "x", "--range", "abc-def"], /invalid --range/],
    [["release", "--port", "abc"], /invalid --port/],
  ];
  let strictOk = true;
  for (const [args, re] of flagCases) {
    const r = await runCli(args);
    if (r.code !== 1 || !re.test(r.err)) { strictOk = false; console.log(`    (flag case failed: ${args.join(" ")} → code ${r.code}, stderr: ${r.err.trim()})`); }
  }
  ok("non-numeric --ttl/--pid/--port/--count/--range exit 1 with a clear message", strictOk);
  ok("no reservation leaked from rejected flags", !registry.list().some((r) => r.port === 47750));
  // …and a valid --ttl still reserves, recording a real expiry (the silent-permanent path is gone).
  const good = await runCli(["reserve", "--project", "ttl-ok", "--port", "47751", "--ttl", "60", "--adopt", "--json"]);
  const goodRow = good.code === 0 ? JSON.parse(good.out)[0] : null;
  ok("valid --ttl reserves with expiresAt recorded", !!goodRow && typeof goodRow.expiresAt === "string");

  // ── `portbook list --json` is ALWAYS a bare array of reservation rows (the documented `jq '.[]'`
  // contract) even when blocks exist — they do here. Blocks keep their own `blocks --json` surface.
  const lj = await runCli(["list", "--json", "--no-probe"]);
  const shape = JSON.parse(lj.out);
  ok("list --json stays a bare array even when blocks exist",
    lj.code === 0 && Array.isArray(shape) && shape.every((r) => typeof r.port === "number") && registry.listBlocks().length > 0);
  const bj = await runCli(["blocks", "--json"]);
  const bshape = JSON.parse(bj.out);
  ok("blocks --json is the blocks surface (bare array)", bj.code === 0 && Array.isArray(bshape) && bshape.some((b) => b.rangeStart === 47720));

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
