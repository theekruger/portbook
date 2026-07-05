// Audit-trail + renew + PID-identity test — the v0.6.0 "who did what, when (and PID reuse can't
// lie)" feature set. Hermetic: throwaway registry dir, high ports, our own PID as the live process.
// Scrub fleet env vars before importing src modules (a machine configured per docs/FLEET.md exports
// them) so the test stays hermetic.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));

const { reserve, release, renew, gc, readEvents, readRegistry, writeRegistry, parseEtime, pidStartTimes,
  reserveBlock, releaseBlock, requestPort, resolveRequest, EVENTS_FILE } = await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const me = os.hostname();

// ── 1. events are written for the whole lifecycle, with the right fields ──────────────────────────
{
  const [r] = await reserve({ project: "audit", port: 46100, owner: "tester", purpose: "trail" });
  await release({ port: 46100 });
  const events = readEvents({ port: 46100 });
  ok("reserve + release both leave events", events.length === 2);
  ok("reserve event carries who/what", events[0].op === "reserve" && events[0].project === "audit" && events[0].owner === "tester" && events[0].machine === me);
  ok("release event follows", events[1].op === "release" && events[1].port === 46100);
  ok("events carry ISO timestamps", !Number.isNaN(Date.parse(events[0].at)));
  ok("reserve returned the row (sanity)", r.port === 46100);
}

// ── 2. gc'd holds are audited WITH the reason — the "who killed my server" answer ─────────────────
{
  await reserve({ project: "ttl-hold", port: 46101, ttlSec: 1 });
  const reg = readRegistry();
  reg.reservations.find((r) => r.port === 46101).expiresAt = new Date(Date.now() - 1000).toISOString();
  writeRegistry(reg);
  const removed = await gc();
  ok("gc reclaims the expired hold", removed.some((r) => r.port === 46101));
  const e = readEvents({ port: 46101, op: "gc" });
  ok("gc event records the reason", e.length === 1 && e[0].reason === "ttl-expired" && e[0].project === "ttl-hold");
}

// ── 3. block / request / grant / deny leave a trail too ───────────────────────────────────────────
{
  await reserveBlock({ project: "terr", rangeStart: 46200, rangeEnd: 46210 });
  await reserve({ project: "holder", port: 46150 });
  const q = await requestPort({ port: 46150, fromProject: "asker", reason: "want it" });
  await resolveRequest({ id: q.id, action: "grant", note: "ok" });
  const q2 = await requestPort({ port: 46205, fromProject: "asker2" }); // targets the block
  await resolveRequest({ id: q2.id, action: "deny", note: "mine" });
  ok("block event", readEvents({ op: "block" }).some((e) => e.project === "terr" && e.range === "46200-46210"));
  ok("request event keys project to the REQUESTER", readEvents({ op: "request", port: 46150 })[0]?.project === "asker");
  ok("grant event records the handover + note", readEvents({ op: "grant", port: 46150 })[0]?.note === "ok");
  ok("deny event records the refusal", readEvents({ op: "deny", port: 46205 })[0]?.target === "terr");
  await releaseBlock({ project: "terr" });
  ok("block-release event", readEvents({ op: "block-release" }).some((e) => e.project === "terr"));
}

// ── 4. readEvents filters AND, tolerates torn lines, respects limit ───────────────────────────────
{
  fs.appendFileSync(EVENTS_FILE, '{"at":"2026-01-01T00:00:00Z","op":"reserve","port":46999,"pro'); // torn (no newline yet — next append continues the line)
  fs.appendFileSync(EVENTS_FILE, "\n");
  const all = readEvents({});
  ok("torn line is skipped, not fatal", all.length > 0 && all.every((e) => e.op));
  ok("filter by project", readEvents({ project: "audit" }).every((e) => e.project === "audit"));
  ok("filter by op AND port", readEvents({ op: "gc", port: 46101 }).length === 1);
  ok("limit keeps the NEWEST rows", readEvents({ limit: 2 }).length === 2 && readEvents({ limit: 2 })[1].op === all[all.length - 1].op);
}

// ── 5. rotation: an oversized events file rolls to .1 and both generations are read ───────────────
{
  process.env.PORTBOOK_EVENTS_MAX_BYTES = "1"; // next append rotates
  // (the env is read at module load — emulate rotation directly instead)
  delete process.env.PORTBOOK_EVENTS_MAX_BYTES;
  fs.renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
  await reserve({ project: "gen2", port: 46102 });
  const all = readEvents({});
  ok("both generations are read after rotation",
    all.some((e) => e.project === "audit") && all.some((e) => e.project === "gen2"));
  await release({ port: 46102 });
}

// ── 6. renew extends TTL holds in place — and refuses to make a permanent hold ephemeral ──────────
{
  await reserve({ project: "renewer", port: 46103, ttlSec: 5 });
  await reserve({ project: "renewer", port: 46104 }); // permanent
  const before = readRegistry().reservations.find((r) => r.port === 46103).expiresAt;
  const renewed = await renew({ project: "renewer", ttlSec: 3600 });
  ok("renew touches only the TTL hold", renewed.length === 1 && renewed[0].port === 46103);
  const after = readRegistry().reservations.find((r) => r.port === 46103).expiresAt;
  ok("renew pushed expiresAt forward", Date.parse(after) > Date.parse(before));
  ok("the permanent hold stays permanent", readRegistry().reservations.find((r) => r.port === 46104).expiresAt === null);
  ok("renew event in the trail", readEvents({ op: "renew", port: 46103 }).length === 1);
  let badTtl = false; try { await renew({ project: "renewer" }); } catch { badTtl = true; }
  ok("renew without --ttl fails loudly", badTtl);
  await release({ project: "renewer" });
}

// ── 7. PID identity: start time is stamped; gc unmasks a REUSED pid ────────────────────────────────
{
  ok("parseEtime handles mm:ss / hh:mm:ss / dd-hh:mm:ss",
    parseEtime("05:09") === 309 && parseEtime("1:02:03") === 3723 && parseEtime("2-01:00:00") === 176400 && parseEtime("garbage") === null);
  const starts = await pidStartTimes([process.pid]);
  const own = starts.get(process.pid);
  ok("pidStartTimes resolves our own pid (or degrades to null, never throws)", own === null || (typeof own === "number" && own <= Date.now()));

  const [r] = await reserve({ project: "pidder", port: 46105, pid: process.pid });
  ok("reserve stamps pidStartedAt for a live pid", r.pidStartedAt === null || Math.abs(r.pidStartedAt - (Date.now() - process.uptime() * 1000)) < 5000);

  // Forge the recorded start time to something absurd: the pid is ALIVE (it's us) so plain reconcile
  // keeps it — only gc's deep check can tell it's "a different process" and reclaim it.
  const reg = readRegistry();
  reg.reservations.find((x) => x.port === 46105).pidStartedAt = 12345;
  writeRegistry(reg);
  const removed = await gc();
  if (own === null) {
    // Platform couldn't resolve start times — the deep check must NOT have judged (fail open).
    ok("unjudgeable pids are never reclaimed", !removed.some((x) => x.port === 46105));
    await release({ port: 46105 });
  } else {
    ok("gc unmasks the reused pid", removed.some((x) => x.port === 46105));
    ok("pid-reused gc event in the trail", readEvents({ op: "gc", port: 46105 })[0]?.reason === "pid-reused");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
