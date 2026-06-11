// Tests for the environment providers (pure port-string parsing) and the HTTP server.
// Runs against a throwaway registry dir; the OS/container enumeration is exercised for shape only,
// so this passes whether or not a container runtime is installed.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

// Tests must not inherit fleet config (docs/FLEET.md tells users to export these in the profile):
// a leaked PORTBOOK_TOKEN would make createServer() below demand auth and 401 every fetch.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-env-test-"));
const { parsePorts, ecosystem } = await import("../src/environments.js");
const { createServer } = await import("../src/server.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// --- parsePorts (pure) ---
const a = parsePorts("127.0.0.1:6379->6379/tcp, 0.0.0.0:8025->8025/tcp, [::]:8025->8025/tcp, 6380/tcp");
ok("parsePorts dedups IPv4/IPv6 of the same host port", a.published.length === 2);
ok("parsePorts maps host->container", a.published.find((p) => p.hostPort === 6379)?.containerPort === 6379);
ok("parsePorts keeps the host IP", a.published.find((p) => p.hostPort === 6379)?.hostIp === "127.0.0.1");
ok("parsePorts captures internal-only (exposed, unpublished) ports", a.internal.length === 1 && a.internal[0].containerPort === 6380);
ok("parsePorts tolerates an empty string", parsePorts("").published.length === 0 && parsePorts(undefined).internal.length === 0);

// Docker compresses contiguous publishes (`-p 8000-8005:8000-8005`) into ONE ranged token — it must
// expand to per-port mappings (the old single-port regex dropped the whole token silently).
const r = parsePorts("0.0.0.0:8000-8005->8000-8005/tcp, [::]:8000-8005->8000-8005/tcp");
ok("parsePorts expands a published range to per-port mappings (IPv4/IPv6 deduped)", r.published.length === 6);
ok("parsePorts pairs ranged host->container ports positionally", r.published.every((p) => p.containerPort === p.hostPort) && !!r.published.find((p) => p.hostPort === 8003));
const off = parsePorts("127.0.0.1:5000-5002->3000-3002/udp");
ok("parsePorts keeps offset + ip + proto across a range", off.published.length === 3 && off.published.find((p) => p.hostPort === 5001)?.containerPort === 3001 && off.published[0].hostIp === "127.0.0.1" && off.published[0].proto === "udp");
const ri = parsePorts("9000-9002/tcp");
ok("parsePorts expands an internal-only range", ri.internal.length === 3 && ri.internal.map((p) => p.containerPort).join() === "9000,9001,9002");
ok("parsePorts caps pathological range expansion at 256", parsePorts("0.0.0.0:1-65535->1-65535/tcp").published.length === 256 && parsePorts("1-65535/tcp").internal.length === 256);
ok("parsePorts still parses single ports alongside a range", parsePorts("0.0.0.0:9100->9100/tcp, 8000-8001/tcp").published.length === 1 && parsePorts("0.0.0.0:9100->9100/tcp, 8000-8001/tcp").internal.length === 2);

// --- ecosystem() shape ---
const e = await ecosystem();
ok("ecosystem returns the expected arrays + summary", Array.isArray(e.ports) && Array.isArray(e.containers) && Array.isArray(e.ghosts) && Array.isArray(e.wsl) && !!e.summary && !!e.runtimes);

// --- ecosystem() is machine-scoped (fleet host) ---
// On a fleet host the local ledger holds OTHER machines' rows too. A remote hold must never label a
// local listener "managed" and must never surface as a releasable local "ghost" (mirrors scan()).
const { reserve } = await import("../src/registry.js");
const lst = net.createServer();
await new Promise((r) => lst.listen(0, "127.0.0.1", r));
const lp = lst.address().port; // a REAL local listener whose port a remote machine also reserved
await reserve({ project: "remote-proj", port: lp, machine: "other-box", adopt: true });
await reserve({ project: "remote-proj", port: 46987, machine: "other-box", adopt: true }); // remote, not listening here
const [localGhost] = await reserve({ project: "local-proj", count: 1, rangeStart: 46100, rangeEnd: 46199 });
const e2 = await ecosystem();
ok("ecosystem: remote-machine rows never show as local ghosts", e2.ghosts.every((g) => g.machine !== "other-box"));
ok("ecosystem: a local reservation still ghosts", e2.ghosts.some((g) => g.port === localGhost.port && g.project === "local-proj"));
ok("ecosystem: a remote row never labels a local listener", e2.ports.every((p) => p.reservation?.machine !== "other-box"));
await new Promise((r) => lst.close(r));

// --- HTTP server ---
const srv = createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

ok("GET /api/list returns an array", Array.isArray(await (await fetch(base + "/api/list")).json()));
const eco = await (await fetch(base + "/api/ecosystem")).json();
ok("GET /api/ecosystem returns the ecosystem shape", Array.isArray(eco.ports) && !!eco.summary);
const html = await (await fetch(base + "/")).text();
ok("GET / serves the dashboard HTML", html.includes("portbook") && html.includes("/api/ecosystem"));
ok("unknown path 404s", (await fetch(base + "/nope")).status === 404);
const gc = await (await fetch(base + "/api/gc", { method: "POST" })).json();
ok("POST /api/gc returns a reclaimed count", typeof gc.reclaimed === "number");

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
