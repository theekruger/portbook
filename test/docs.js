// Docs-vs-code contract + dashboard ordering guard.
//  1) Every `GET/POST /path` endpoint documented in docs/FLEET.md and docs/INTEGRATIONS.md must be a
//     real route in src/server.js (the tables once drifted to un-prefixed pre-implementation paths).
//  2) No doc may advertise the nonexistent `serve --token` flag (auth is the PORTBOOK_TOKEN env var)
//     or the merged `--bind host:port` form, and INTEGRATIONS.md must carry the v0.4.0 blocks routes
//     plus gc's real `{ reclaimed: <count> }` shape.
//  3) public/index.html's refresh() must be ordering-guarded: a slow, OLDER /api response resolving
//     after a newer one must never repaint the dashboard. We run the page's real <script> in a vm
//     with a stubbed DOM/fetch and settle responses out of order.
// Scrub fleet env vars before anything else so a machine configured per docs/FLEET.md still passes.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const serverSrc = read("src/server.js");
const fleet = read("docs/FLEET.md");
const integrations = read("docs/INTEGRATIONS.md");
const readme = read("README.md");

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// ── 1. Documented endpoints exist. `/api/check/:port` normalizes to the `/api/check/` prefix match.
const documented = [...fleet.matchAll(/`(GET|POST)\s+(\/[^\s`]*)`/g), ...integrations.matchAll(/`(GET|POST)\s+(\/[^\s`]*)`/g)]
  .map((m) => m[2]);
ok(documented.length >= 15, `endpoint regex found only ${documented.length} documented endpoints — pattern drift?`);
for (const p of documented) {
  const norm = p.split("?")[0].replace(/\/:[^/]+$/, "/");
  ok(serverSrc.includes(`"${norm}"`), `docs document ${p} but src/server.js has no route string "${norm}"`);
}

// ── 2. Token is env-var-only; serve flags are real; INTEGRATIONS.md covers blocks + real gc shape.
for (const [name, doc] of [["FLEET.md", fleet], ["INTEGRATIONS.md", integrations], ["README.md", readme]]) {
  ok(!/portbook serve[^\n]*--token/.test(doc), `${name} shows a \`serve --token\` invocation — that flag does not exist`);
  ok(!/--bind\s+\S+:\d+/.test(doc), `${name} merges host:port into --bind (serve takes --bind <host> --port <p>)`);
}
ok(fleet.includes("PORTBOOK_TOKEN=<secret> portbook serve"), "FLEET.md must show the bash env-var serve form");
ok(fleet.includes('$env:PORTBOOK_TOKEN'), "FLEET.md must show the PowerShell env-var serve form");
ok(!fleet.includes("?machine="), "FLEET.md claims an unimplemented ?machine= filter");
ok(!fleet.includes("server merges"), "FLEET.md claims unimplemented server-side scan merging");
ok(integrations.includes("/api/blocks") && integrations.includes("/api/blocks/release"),
  "INTEGRATIONS.md must document the v0.4.0 blocks routes");
ok(integrations.includes("{ reclaimed: <count> }"), "INTEGRATIONS.md must document gc's real { reclaimed: <count> } shape");
ok(integrations.includes("raw=1"), "INTEGRATIONS.md must document ?raw=1 on /api/list");

// ── 3. Dashboard ordering guard. Stub just enough DOM for public/index.html's script and make fetch
// fully test-controlled: each call parks until the test settles it, so we can deliver out of order.
const script = read("public/index.html").match(/<script>([\s\S]*?)<\/script>/)[1];
const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, { textContent: "", innerHTML: "", hidden: false, checked: false, onchange: null, onclick: null });
  return els.get(id);
};
const pending = []; // every fetch in call order: { path, done, respond(body) }
const sandbox = {
  document: { getElementById: el, addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { prompt: () => null },
  fetch: (p) => new Promise((res) => pending.push({ path: p, done: false, respond: (body) => res({ status: 200, json: async () => body }) })),
  setInterval: () => 0,
  clearInterval: () => {},
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox); // bottom of the script kicks off refresh() #1 (parks on /api/blocks)

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (times = 3) => { for (let i = 0; i < times; i++) await tick(); };
const next = (p) => { const q = pending.find((x) => !x.done && x.path === p); assert.ok(q, `expected a pending fetch for ${p}`); q.done = true; return q; };
const eco = (machine) => ({ machine, at: new Date().toISOString(), runtimes: {},
  summary: { listening: 0, managed: 0, container: 0, unmanaged: 0, ghosts: 0, containers: 0 },
  ports: [], containers: [], wsl: [], ghosts: [] });

// A: refresh #1 is parked on /api/blocks. Run refresh #2 to completion, THEN deliver #1's response.
const stale1 = next("/api/blocks");      // #1's parked fetch — held back
const p2 = sandbox.refresh();
next("/api/blocks").respond([]);
await settle();
next("/api/ecosystem").respond(eco("fresh"));
await p2;
next("/api/fleet").respond({ reservations: [], blocks: [], reports: {} });
await settle();
assert.equal(el("machine").textContent, "fresh"); n++;
stale1.respond([{ project: "stale", rangeStart: 1, rangeEnd: 2 }]); // the OLD refresh resolves late
await settle();
// Unguarded code would now re-fetch /api/ecosystem for the stale pass; feed it bait if it does.
const bait = pending.find((x) => !x.done && x.path === "/api/ecosystem");
if (bait) { bait.done = true; bait.respond(eco("STALE")); await settle(); }
ok(el("machine").textContent === "fresh", "a late /api/blocks from an OLD refresh must not restart a stale render");
ok(el("blocksSection").hidden === true, "a late stale refresh must not resurrect the blocks table");

// B: stale /api/fleet — #3's fleet response arrives after #4's. Only #4's table may stand.
const p3 = sandbox.refresh();
next("/api/blocks").respond([]); await settle();
next("/api/ecosystem").respond(eco("fresh")); await p3;
const fleet3 = next("/api/fleet");       // held back — will arrive late
const p4 = sandbox.refresh();
next("/api/blocks").respond([]); await settle();
next("/api/ecosystem").respond(eco("fresh")); await p4;
next("/api/fleet").respond({ reservations: [{ machine: "m-a", port: 1 }, { machine: "m-b", port: 2 }], blocks: [], reports: {} });
await settle();
ok(el("fleet").innerHTML.includes("m-a"), "fresh fleet table should render");
fleet3.respond({ reservations: [{ machine: "OLD-x", port: 9 }, { machine: "OLD-y", port: 8 }], blocks: [], reports: {} });
await settle();
ok(el("fleet").innerHTML.includes("m-a") && !el("fleet").innerHTML.includes("OLD-x"),
  "a late /api/fleet from an OLD refresh must not overwrite the newer fleet table");

// C: stale /api/ecosystem — #5 parks on ecosystem, #6 completes, then #5's ecosystem lands.
const p5 = sandbox.refresh();
next("/api/blocks").respond([]); await settle();
const eco5 = next("/api/ecosystem");     // held back — will arrive late
const p6 = sandbox.refresh();
next("/api/blocks").respond([]); await settle();
next("/api/ecosystem").respond(eco("newest")); await p6;
next("/api/fleet").respond({ reservations: [], blocks: [], reports: {} });
await settle();
assert.equal(el("machine").textContent, "newest"); n++;
eco5.respond(eco("ANCIENT"));
await p5; await settle();
ok(el("machine").textContent === "newest", "a late /api/ecosystem from an OLD refresh must not repaint the dashboard");

console.log(`docs+dashboard: ${n} checks passed`);
