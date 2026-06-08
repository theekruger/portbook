// Tests for the environment providers (pure port-string parsing) and the HTTP server.
// Runs against a throwaway registry dir; the OS/container enumeration is exercised for shape only,
// so this passes whether or not a container runtime is installed.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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

// --- ecosystem() shape ---
const e = await ecosystem();
ok("ecosystem returns the expected arrays + summary", Array.isArray(e.ports) && Array.isArray(e.containers) && Array.isArray(e.ghosts) && Array.isArray(e.wsl) && !!e.summary && !!e.runtimes);

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
