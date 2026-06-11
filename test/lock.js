// Lock test — the registry lock under contention: mutual exclusion, ATOMIC stale-lock takeover
// (crashed holders are reclaimed), heartbeat (a live slow holder that touches the lock is never
// judged stale), and owner-checked release (a holder whose lock WAS stolen must not remove the
// thief's lock). $PORTBOOK_LOCK_STALE_MS shrinks the 15s production window to something testable.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// A dev machine configured per docs/FLEET.md exports these — scrub them so the test is hermetic.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-lock-test-"));
process.env.PORTBOOK_LOCK_STALE_MS = "600";
const { withLock, reserve, list } = await import("../src/registry.js");

const LOCK = path.join(process.env.PORTBOOK_DIR, "registry.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// (1) Baseline: concurrent withLock sections never overlap.
{
  let inside = 0, maxInside = 0;
  const job = () => withLock(async () => { inside++; maxInside = Math.max(maxInside, inside); await sleep(30); inside--; });
  await Promise.all([job(), job(), job()]);
  ok("withLock serializes concurrent critical sections", maxInside === 1);
}

// (2) A crashed holder's stale lock is taken over (atomically) and the taker proceeds + cleans up.
{
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, "owner"), "dead-process-token");
  const old = new Date(Date.now() - 5000); // far beyond the 600ms stale window
  fs.utimesSync(LOCK, old, old);
  let took = false;
  await withLock(async () => { took = true; });
  ok("stale (crashed-holder) lock is reclaimed and withLock proceeds", took);
  ok("reclaimed lock is removed after release", !fs.existsSync(LOCK));
}

// (3) HEARTBEAT: a slow holder that keeps touching the lock (as reserve's probe loop does) is never
// judged stale — a waiter may enter only AFTER it releases, even though the hold far exceeds 600ms.
{
  let holderDone = 0, waiterEntered = 0;
  const holder = withLock(async () => {
    for (let i = 0; i < 8; i++) { await sleep(120); const t = new Date(); try { fs.utimesSync(LOCK, t, t); } catch { /* gone */ } }
    holderDone = Date.now();
  });
  await sleep(100); // let the holder acquire first
  const waiter = withLock(async () => { waiterEntered = Date.now(); });
  await Promise.all([holder, waiter]);
  ok("a live heartbeating holder is never stolen from", holderDone > 0 && waiterEntered >= holderDone);
}

// (4) OWNER-CHECKED RELEASE: a silent over-stale holder IS stolen from (treated as crashed) — but when
// it finally releases, it must leave the thief's lock in place instead of admitting a third process.
{
  let thiefIn = 0, victimOut = 0, lockAliveAfterVictimRelease = false;
  const victim = withLock(async () => { await sleep(1500); /* no heartbeat — looks crashed */ }).then(() => {
    victimOut = Date.now();
    lockAliveAfterVictimRelease = fs.existsSync(LOCK); // the thief still holds it
  });
  await sleep(700); // past the 600ms stale window — the victim's lock is now stealable
  const thief = withLock(async () => { thiefIn = Date.now(); await sleep(1200); });
  await Promise.all([victim, thief]);
  ok("a silent over-stale holder is stolen from (thief entered while victim ran)", thiefIn > 0 && thiefIn < victimOut);
  ok("victim's release left the thief's lock in place (owner token respected)", lockAliveAfterVictimRelease);
  ok("thief's own release removes the lock", !fs.existsSync(LOCK));
}

// (5) End-to-end: concurrent mutators never lose each other's writes (the original bug's smoking gun).
{
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    reserve({ project: `p${i}`, count: 1, rangeStart: 42000, rangeEnd: 42100, probe: false })));
  const ports = list().map((r) => r.port);
  ok("concurrent reserves all persist with distinct ports (no lost update)", ports.length === N && new Set(ports).size === N);
}

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
