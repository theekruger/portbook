// Port-territory test — exercises reserveBlock/releaseBlock/listBlocks and the way blocks steer
// reserve(): owners auto-pick inside their territory, everyone else is kept out. Throwaway registry
// dir; specific-port reserves use adopt:true (no real bind) and a high range to avoid colliding with
// anything actually listening on the test machine.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// A dev machine configured per docs/FLEET.md exports these — scrub them so the test is hermetic.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
const { reserve, reserveBlock, releaseBlock, listBlocks } = await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const inRange = (p, lo, hi) => p >= lo && p <= hi;

// (1) reserveBlock creates a block that listBlocks surfaces.
const blk = await reserveBlock({ project: "alpha", rangeStart: 47000, rangeEnd: 47099, owner: "blocks" });
ok("reserveBlock returns a block", blk && blk.rangeStart === 47000 && blk.rangeEnd === 47099 && !!blk.id);
ok("listBlocks shows the new block", listBlocks().some((b) => b.id === blk.id && b.project === "alpha"));

// (1b) Re-claiming the IDENTICAL block (same project/range/machine) is IDEMPOTENT — the existing row
// comes back, sequentially and under a race; the ledger never stacks duplicates.
const again = await reserveBlock({ project: "alpha", rangeStart: 47000, rangeEnd: 47099 });
ok("identical re-claim returns the existing block (same id)", again.id === blk.id);
const racers = await Promise.all([
  reserveBlock({ project: "alpha", rangeStart: 47000, rangeEnd: 47099 }),
  reserveBlock({ project: "alpha", rangeStart: 47000, rangeEnd: 47099 }),
]);
ok("racing identical claims never stack duplicates",
  racers.every((b) => b.id === blk.id) && listBlocks({ project: "alpha" }).length === 1);

// (2) A specific port inside ANOTHER project's block is rejected.
let foreignPort = false;
try { await reserve({ project: "beta", port: 47050, adopt: true }); } catch { foreignPort = true; }
ok("specific port inside another project's block is rejected", foreignPort);

// (3) A specific port inside the SAME project's own block is allowed.
const own = await reserve({ project: "alpha", port: 47050, adopt: true });
ok("specific port inside own block is allowed", own.length === 1 && own[0].port === 47050);

// (4) Auto-pick (count 1) for the block owner lands INSIDE its block.
const ownerPick = await reserve({ project: "alpha", count: 1 });
ok("auto-pick for block owner lands inside its block",
  ownerPick.length === 1 && inRange(ownerPick[0].port, 47000, 47099));

// (5) Auto-pick for a DIFFERENT project avoids the block (falls back to the default 4000-4999 range).
const otherPick = await reserve({ project: "gamma", count: 1 });
ok("auto-pick for a different project avoids the block",
  otherPick.length === 1 && !inRange(otherPick[0].port, 47000, 47099));

// (6) An OVERLAPPING block from another project is rejected; a non-overlapping one succeeds.
let overlap = false;
try { await reserveBlock({ project: "delta", rangeStart: 47050, rangeEnd: 47150 }); } catch { overlap = true; }
ok("overlapping block from another project is rejected", overlap);
const apart = await reserveBlock({ project: "delta", rangeStart: 47200, rangeEnd: 47299 });
ok("non-overlapping block from another project succeeds", apart.rangeStart === 47200);

// (7) reserveBlock that would swallow another project's existing reservation is rejected.
await reserve({ project: "epsilon", port: 47500, adopt: true });
let swallow = false;
try { await reserveBlock({ project: "zeta", rangeStart: 47450, rangeEnd: 47550 }); } catch { swallow = true; }
ok("block containing another project's reservation is rejected", swallow);

// (8) releaseBlock removes the block.
const removed = await releaseBlock({ project: "alpha" });
ok("releaseBlock removes the block", removed >= 1 && listBlocks({ project: "alpha" }).length === 0);

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
