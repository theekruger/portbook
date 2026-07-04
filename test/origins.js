// Tailnet staging-origins test — the `expose`/`origins`/`release`-teardown/`doctor` feature.
// Two halves, both hermetic (no `tailscale` binary needed):
//   1) the PURE tailscale parsers (captured JSON → normalized shapes), exercised on any OS;
//   2) the registry ORIGIN ledger (addOrigin/listOrigins/originsFor/removeOrigin + release teardown),
//      against a throwaway registry dir using high local/ts ports so nothing real is touched.
// Scrub fleet env vars before importing src modules (a machine configured per docs/FLEET.md exports
// them) so the test stays hermetic.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));

const { parseMagicDnsName, parseServeStatus, parseServePorts, pickTsPort } = await import("../src/tailscale.js");
const { reserve, release, addOrigin, listOrigins, originsFor, removeOrigin, readRegistry, writeRegistry } =
  await import("../src/registry.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const me = os.hostname();

// ── 1. pure parsers ────────────────────────────────────────────────────────────────────────────────
// `tailscale status --json` → Self.DNSName, trailing dot stripped.
{
  const sample = JSON.stringify({ Self: { DNSName: "laptop-glklll8b.tailf23b1e.ts.net.", HostName: "LAPTOP" }, MagicDNSSuffix: "tailf23b1e.ts.net" });
  ok("parseMagicDnsName strips the trailing dot", parseMagicDnsName(sample) === "laptop-glklll8b.tailf23b1e.ts.net");
  ok("parseMagicDnsName → null when Self.DNSName missing", parseMagicDnsName(JSON.stringify({ Self: {} })) === null);
  ok("parseMagicDnsName → null on garbage (no throw)", parseMagicDnsName("not json") === null && parseMagicDnsName("") === null);
}

// `tailscale serve status --json` → [{host, tsPort, localPort, url}] from .Web, sorted by tsPort.
{
  const sample = JSON.stringify({
    TCP: { 8443: { HTTPS: true }, 9443: { HTTPS: true } },
    Web: {
      "laptop-glklll8b.tailf23b1e.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9001" } } },
      "laptop-glklll8b.tailf23b1e.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4100" } } },
    },
  });
  const rows = parseServeStatus(sample);
  ok("parseServeStatus returns one row per Web mapping", rows.length === 2);
  ok("parseServeStatus sorts by tsPort", rows[0].tsPort === 8443 && rows[1].tsPort === 9443);
  ok("parseServeStatus extracts host/tsPort/localPort/url",
    rows[0].host === "laptop-glklll8b.tailf23b1e.ts.net" && rows[0].localPort === 4100 &&
    rows[0].url === "https://laptop-glklll8b.tailf23b1e.ts.net:8443");
  ok("parseServeStatus tolerates a proxy with a trailing slash",
    parseServeStatus(JSON.stringify({ Web: { "h:7000": { Handlers: { "/": { Proxy: "http://127.0.0.1:5180/" } } } } }))[0].localPort === 5180);
  ok("parseServeStatus → [] on empty/garbage (no throw)", parseServeStatus("").length === 0 && parseServeStatus("{}").length === 0 && parseServeStatus("nope").length === 0);

  // parseServePorts unions the .TCP keys and the .Web tsPorts.
  const ports = parseServePorts(sample);
  ok("parseServePorts includes every serving tsPort", ports.has(8443) && ports.has(9443) && ports.size === 2);
  ok("parseServePorts → empty set on garbage", parseServePorts("nope").size === 0);
}

// pickTsPort: lowest free in range, avoiding live serve ports AND portbook-reserved tsPorts.
{
  ok("pickTsPort picks the lowest free port", pickTsPort(new Set(), new Set()) === 8443);
  ok("pickTsPort skips a live serve port", pickTsPort(new Set([8443]), new Set()) === 8444);
  ok("pickTsPort skips a portbook-reserved tsPort too", pickTsPort(new Set([8443]), new Set([8444])) === 8445);
  let exhausted = false;
  try { pickTsPort(new Set([9000]), new Set(), 9000, 9000); } catch { exhausted = true; }
  ok("pickTsPort throws when the range is exhausted", exhausted);
}

// ── 2. registry origin ledger ────────────────────────────────────────────────────────────────────
// addOrigin records an origin keyed on {project, localPort}; listOrigins surfaces it.
const o1 = await addOrigin({ project: "jobgetter", localPort: 54180, tsPort: 18443, url: "https://host:18443", host: "host", owner: "tester" });
ok("addOrigin returns a row with an id + createdAt", !!o1.id && !!o1.createdAt && o1.tsPort === 18443);
ok("listOrigins surfaces the new origin", listOrigins().some((o) => o.id === o1.id && o.project === "jobgetter"));
ok("listOrigins filters by project", listOrigins({ project: "jobgetter" }).length === 1 && listOrigins({ project: "nope" }).length === 0);

// addOrigin is IDEMPOTENT on {project, localPort}: re-exposing the same app's same local port UPDATES
// the row (new tsPort/url) in place, same id — never a duplicate.
const o1b = await addOrigin({ project: "jobgetter", localPort: 54180, tsPort: 18444, url: "https://host:18444", host: "host" });
ok("re-exposing the same {project,localPort} updates in place (same id)", o1b.id === o1.id && o1b.tsPort === 18444);
ok("idempotent re-expose never stacks duplicates", listOrigins({ project: "jobgetter" }).length === 1);

// A DIFFERENT project claiming the same tsPort is refused (the collision class the feature prevents).
let dualClaim = false;
try { await addOrigin({ project: "other", localPort: 54190, tsPort: 18444, url: "https://host:18444", host: "host" }); } catch { dualClaim = true; }
ok("another project claiming a live tsPort is refused", dualClaim);

// originsFor uses the same ANDed selectors release()/teardown uses.
ok("originsFor(project) matches", originsFor({ project: "jobgetter" }).length === 1);
ok("originsFor(port) matches the LOCAL port", originsFor({ port: 54180 }).length === 1);
ok("originsFor(project+port) ANDs — non-matching pair → none", originsFor({ project: "jobgetter", port: 99999 }).length === 0);

// release(project) drops the reservation AND the origin record in the same write (teardown's ledger half).
await reserve({ project: "jobgetter", port: 54180, adopt: true }); // the local port reservation expose would have made
ok("the reservation exists pre-release", listOrigins().length === 1);
const releasedN = await release({ project: "jobgetter" });
ok("release(project) removed the reservation", releasedN === 1);
ok("release(project) also dropped the staging origin — no orphan", listOrigins({ project: "jobgetter" }).length === 0);

// removeOrigin drops an origin record without touching reservations.
const o2 = await addOrigin({ project: "alpha", localPort: 54200, tsPort: 18500, url: "https://host:18500", host: "host" });
await reserve({ project: "alpha", port: 54200, adopt: true });
const removed = await removeOrigin({ id: o2.id });
ok("removeOrigin(id) drops just the origin", removed === 1 && listOrigins({ project: "alpha" }).length === 0);
ok("removeOrigin leaves the reservation intact", (await import("../src/registry.js")).list({ project: "alpha" }).length === 1);
await release({ project: "alpha" });

// ── 3. graceful migration: a registry written by an OLDER portbook (no `origins` field) round-trips.
{
  const reg = readRegistry();
  delete reg.origins;            // simulate a pre-v0.6.0 on-disk registry
  writeRegistry(reg);
  const back = readRegistry();
  ok("readRegistry normalizes a missing origins field to []", Array.isArray(back.origins) && back.origins.length === 0);
  // and addOrigin still works against the migrated registry
  const o3 = await addOrigin({ project: "mig", localPort: 54300, tsPort: 18600, url: "https://host:18600", host: "host" });
  ok("addOrigin works after migrating a legacy registry", listOrigins({ project: "mig" }).some((o) => o.id === o3.id));
  await removeOrigin({ id: o3.id });
}

// origins are this-machine scoped: a row stamped for ANOTHER machine never shows in local listings.
{
  await addOrigin({ project: "remote", localPort: 54400, tsPort: 18700, url: "https://other:18700", host: "other", machine: "some-other-box" });
  ok("listOrigins ignores another machine's origin", !listOrigins().some((o) => o.project === "remote"));
  ok("originsFor (default scope) ignores another machine's origin", !originsFor({}).some((o) => o.project === "remote"));
  void me;
}

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
