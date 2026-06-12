// Request/inbox test — the negotiation layer: an agent that wants a HELD port asks through the
// ledger (requestPort) instead of clobbering; the holder answers (resolveRequest). Grant on a
// reservation hands the port over in the same locked write; grant on a block issues a one-shot
// exemption reserve() consumes. Throwaway registry dir; specific-port reserves use adopt:true (no
// real bind) and 47xxx ports to avoid colliding with anything actually listening on this machine.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// A dev machine configured per docs/FLEET.md exports these — scrub them so the test is hermetic.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
const { reserve, release, list, reserveBlock, releaseBlock, listBlocks, requestPort, inbox, outbox, resolveRequest, gc } =
  await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const me = os.hostname();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (1) A request against a held port creates a PENDING row targeting the holder's project + machine.
await reserve({ project: "holder", port: 47010, adopt: true });
const q1 = await requestPort({ port: 47010, fromProject: "wanter", fromOwner: "tester", reason: "demo server" });
ok("request against a held port is pending + unconsumed", q1.status === "pending" && q1.consumed === false && !!q1.id);
ok("request targets the holder's project on this machine", q1.targetProject === "holder" && q1.targetMachine === me);
ok("request records who asked and why", q1.fromProject === "wanter" && q1.fromOwner === "tester" && q1.reason === "demo server");

// (2) Nothing holds the port — don't negotiate, just reserve.
let none = false, noneMsg = "";
try { await requestPort({ port: 47011, fromProject: "wanter" }); } catch (e) { none = true; noneMsg = e.message; }
ok("request for an unheld port throws 'just reserve it'", none && /just reserve it/.test(noneMsg));

// (3) Requesting a port your own project already holds is refused.
let own = false;
try { await requestPort({ port: 47010, fromProject: "holder" }); } catch { own = true; }
ok("requesting your own project's port throws", own);

// (4) Re-filing the identical still-pending ask is IDEMPOTENT — same row back, no inbox flooding.
const q1b = await requestPort({ port: 47010, fromProject: "wanter" });
ok("duplicate pending request returns the existing row (same id)",
  q1b.id === q1.id && outbox({ fromProject: "wanter" }).length === 1);

// (5) inbox: the target project sees it, bystanders don't, and it's machine-scoped.
ok("inbox shows the request to the target project", inbox({ project: "holder" }).some((q) => q.id === q1.id));
ok("inbox for an uninvolved project is empty", inbox({ project: "wanter" }).length === 0);
ok("inbox is machine-scoped", inbox({ project: "holder", machine: "some-other-box" }).length === 0);
ok("inbox with no project shows ALL pending on this machine", inbox().length === 1 && inbox()[0].id === q1.id);

// (6) outbox: the requester's view of everything it filed.
const ob = outbox({ fromProject: "wanter" });
ok("outbox shows the requester's filing with its status", ob.length === 1 && ob[0].id === q1.id && ob[0].status === "pending");

// (6b) Requests against a REMOTE machine's hold land in that machine's inbox, not the local one.
await reserve({ project: "remote-holder", port: 47300, machine: "box-b", probe: false });
const qr = await requestPort({ port: 47300, fromProject: "wanter", machine: "box-b" });
ok("remote request targets the remote machine", qr.targetProject === "remote-holder" && qr.targetMachine === "box-b");
ok("remote request shows in the remote inbox only",
  inbox({ project: "remote-holder", machine: "box-b" }).some((q) => q.id === qr.id) &&
  inbox({ project: "remote-holder" }).length === 0);

// (7) DENY marks the request; the holder keeps the port.
const denied = await resolveRequest({ id: q1.id, action: "deny", note: "still using it" });
ok("deny marks the request denied with a note + resolvedAt",
  denied.status === "denied" && denied.note === "still using it" && !!denied.resolvedAt);
ok("deny releases nothing", denied.releasedReservation === false && list({ project: "holder" }).some((r) => r.port === 47010));

// (8) GRANT on a reservation-held port RELEASES it in the same write — the requester reserves next.
const q2 = await requestPort({ port: 47010, fromProject: "wanter" });
ok("a fresh ask after a denial is a NEW pending row", q2.id !== q1.id && q2.status === "pending");
const granted = await resolveRequest({ id: q2.id, action: "grant", note: "all yours" });
ok("grant reports the holder's reservation released", granted.status === "granted" && granted.releasedReservation === true);
ok("the holder's reservation is gone", !list({ project: "holder" }).some((r) => r.port === 47010));
const handover = await reserve({ project: "wanter", port: 47010, adopt: true });
ok("the requester can immediately reserve the granted port", handover.length === 1 && handover[0].port === 47010);

// (9) GRANT on a BLOCK-held port: territory survives, but the requester gets a ONE-SHOT exemption.
await reserveBlock({ project: "landlord", rangeStart: 47100, rangeEnd: 47199 });
const q3 = await requestPort({ port: 47150, fromProject: "tenant" });
ok("request against a block targets the block's project", q3.targetProject === "landlord");
const g3 = await resolveRequest({ id: q3.id, action: "grant" });
ok("granting a block-held port releases no reservation", g3.releasedReservation === false);
ok("the block itself survives the grant", listBlocks({ project: "landlord" }).length === 1);
const t3 = await reserve({ project: "tenant", port: 47150, adopt: true });
ok("the exemption lets the requester through the block for THAT port", t3.length === 1 && t3[0].port === 47150);
let otherPort = false;
try { await reserve({ project: "tenant", port: 47151, adopt: true }); } catch { otherPort = true; }
ok("another port in the block is still rejected (exemption is port-specific)", otherPort);
await release({ project: "tenant", port: 47150 });
let burnt = false;
try { await reserve({ project: "tenant", port: 47150, adopt: true }); } catch { burnt = true; }
ok("the exemption is one-shot — released and retried, the block rejects again", burnt);

// (10) Resolving anything but a pending request throws (and says what state it's in).
let rerun = false, rerunMsg = "";
try { await resolveRequest({ id: q2.id, action: "deny" }); } catch (e) { rerun = true; rerunMsg = e.message; }
ok("resolving a non-pending request throws with its current status", rerun && /granted/.test(rerunMsg));
let ghost = false;
try { await resolveRequest({ id: "nope", action: "grant" }); } catch { ghost = true; }
ok("resolving an unknown id throws", ghost);
let badAction = false;
try { await resolveRequest({ id: q3.id, action: "maybe" }); } catch { badAction = true; }
ok("an action other than grant/deny throws", badAction);

// (11) PRUNING: with $PORTBOOK_REQUEST_TTL_MS tiny, resolved requests vanish on the next mutation.
const q4 = await requestPort({ port: 47010, fromProject: "loser" }); // 47010 is wanter's now
await resolveRequest({ id: q4.id, action: "deny" });
process.env.PORTBOOK_REQUEST_TTL_MS = "1";
await sleep(15); // age every resolved row past the 1ms window
await gc();      // any mutation reconciles — this is the cheapest one
ok("resolved requests vanish on the next mutation once past the TTL", outbox({ fromProject: "loser" }).length === 0);
delete process.env.PORTBOOK_REQUEST_TTL_MS;

// (12) The pending-per-requester cap: 32 file fine, the 33rd is refused.
await reserveBlock({ project: "warehouse", rangeStart: 47400, rangeEnd: 47499 });
let filed = 0, capped = false;
try { for (let i = 0; i < 33; i++) { await requestPort({ port: 47400 + i, fromProject: "greedy" }); filed++; } }
catch { capped = true; }
ok("a 33rd pending request from one project is capped", capped && filed === 32);

// (13) An unconsumed GRANT is a PROMISE: between grant and the grantee's reserve, the port is held
// for them in the ledger — the snipe-free handover resolveRequest guarantees, enforced in reserve().
await reserve({ project: "old-holder", port: 47020, adopt: true });
const q5 = await requestPort({ port: 47020, fromProject: "heir" });
await resolveRequest({ id: q5.id, action: "grant" });
let snipeMsg = "";
try { await reserve({ project: "sniper", port: 47020, adopt: true }); } catch (e) { snipeMsg = e.message; }
ok("a third party's specific reserve is refused while the grant is unconsumed", /granted to "heir"/.test(snipeMsg));
let exMsg = "";
try { await reserve({ project: "old-holder", port: 47020, adopt: true }); } catch (e) { exMsg = e.message; }
ok("even the EX-holder can't take it back mid-handover", /granted to "heir"/.test(exMsg));
const pick = await reserve({ project: "sniper", rangeStart: 47020, rangeEnd: 47021, probe: false });
ok("auto-pick skips the promised port (lands on the next free one)", pick.length === 1 && pick[0].port === 47021);
const heir = await reserve({ project: "heir", port: 47020, adopt: true });
ok("the grantee's reserve goes through and consumes the grant", heir.length === 1 && heir[0].port === 47020);
let postMsg = "";
try { await reserve({ project: "sniper", port: 47020, adopt: true }); } catch (e) { postMsg = e.message; }
ok("after consumption the port is an ordinary reservation (taken, not promised)", /already reserved/.test(postMsg));

// (14) A pass opens ONLY the wall of the project that GRANTED it. Territory that changed hands after
// the grant stays shut — and the unconsumed grant keeps promising the port (TTL-bounded, never forever).
await reserveBlock({ project: "landlord2", rangeStart: 47600, rangeEnd: 47609 });
const q6 = await requestPort({ port: 47605, fromProject: "tenant2" });
await resolveRequest({ id: q6.id, action: "grant" });
await releaseBlock({ project: "landlord2" });
await reserveBlock({ project: "newlord", rangeStart: 47600, rangeEnd: 47609 });
let churn = false;
try { await reserve({ project: "tenant2", port: 47605, adopt: true }); } catch { churn = true; }
ok("a pass granted by the OLD owner doesn't open the NEW owner's block", churn);
let frozenMsg = "";
try { await reserve({ project: "newlord", port: 47605, adopt: true }); } catch (e) { frozenMsg = e.message; }
ok("the unconsumed grant still promises the port (freeze names the grantee, ages out by TTL)",
  /granted to "tenant2"/.test(frozenMsg));

// (15) The pass is MACHINE-scoped: a grant for box-b's territory doesn't open the same-numbered
// wall on this machine — and it still works on the machine it names.
await reserveBlock({ project: "landlordB", rangeStart: 47500, rangeEnd: 47509, machine: "box-b" });
await reserveBlock({ project: "landlordH", rangeStart: 47500, rangeEnd: 47509 }); // same range, this machine — no overlap across machines
const q7 = await requestPort({ port: 47505, fromProject: "roamer", machine: "box-b" });
await resolveRequest({ id: q7.id, action: "grant" });
let wrongBox = false;
try { await reserve({ project: "roamer", port: 47505, adopt: true }); } catch { wrongBox = true; }
ok("a box-b pass doesn't open this machine's same-numbered block", wrongBox);
const onB = await reserve({ project: "roamer", port: 47505, machine: "box-b", probe: false });
ok("the pass works on the machine it was granted for", onB.length === 1 && onB[0].port === 47505);

// (16) Re-filing after the port CHANGED HANDS files anew at the new holder's door (the dup match
// includes the current holder) — the asker is never stuck returning a stale ask nobody will see.
await reserve({ project: "holder-a", port: 47030, adopt: true });
const q8 = await requestPort({ port: 47030, fromProject: "asker" });
await release({ project: "holder-a", port: 47030 });
await reserve({ project: "holder-b", port: 47030, adopt: true });
const q9 = await requestPort({ port: 47030, fromProject: "asker" });
ok("the re-file is a NEW request targeting the new holder", q9.id !== q8.id && q9.targetProject === "holder-b");
ok("the new holder's inbox sees it", inbox({ project: "holder-b" }).some((q) => q.id === q9.id));

// (17) PRUNING never drops a still-pending ask: the resolved-row TTL is a SEPARATE hook
// ($PORTBOOK_REQUEST_TTL_MS), so aging verdicts out — as (11) does — can't erase open conversations.
const q10 = await requestPort({ port: 47030, fromProject: "patient" });
await resolveRequest({ id: q9.id, action: "deny" });
process.env.PORTBOOK_REQUEST_TTL_MS = "1";
await sleep(15);
await gc();
ok("the denied row is pruned; the pending one survives the resolved-TTL window",
  outbox({ fromProject: "asker" }).every((q) => q.id !== q9.id) &&
  outbox({ fromProject: "patient" }).some((q) => q.id === q10.id && q.status === "pending"));
delete process.env.PORTBOOK_REQUEST_TTL_MS;

// (18) Targeting picks the REAL holder: an expired hold is reconciled away before targeting, and a
// live reservation sitting inside someone else's block outranks the block (the finer claim answers).
await reserve({ project: "mayfly", port: 47040, adopt: true, ttlSec: 0.05 });
await sleep(80);
let goneMsg = "";
try { await requestPort({ port: 47040, fromProject: "vulture" }); } catch (e) { goneMsg = e.message; }
ok("an expired hold is pruned before targeting (nothing to ask)", /just reserve it/.test(goneMsg));
const qa = await requestPort({ port: 47190, fromProject: "tenant9" }); // landlord's block spans it
await resolveRequest({ id: qa.id, action: "grant" });
await reserve({ project: "tenant9", port: 47190, adopt: true });      // consumes the pass
const qb = await requestPort({ port: 47190, fromProject: "subletter" });
ok("a reservation inside another project's block outranks the block as the target", qb.targetProject === "tenant9");

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
