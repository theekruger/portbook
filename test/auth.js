// Auth test — when $PORTBOOK_TOKEN is set, the server gates the DATA api (/api/*) behind a bearer
// token while the dashboard shell (GET /) stays public; the fleet client sends the token automatically.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-auth-test-"));
process.env.PORTBOOK_TOKEN = "secret-xyz"; // captured by createServer() at construction
const { createServer } = await import("../src/server.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

const srv = createServer(); // snapshots PORTBOOK_TOKEN = "secret-xyz"
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

ok("GET /api/* with no token → 401", (await fetch(base + "/api/list")).status === 401);
ok("GET /api/* with a wrong token → 401", (await fetch(base + "/api/list", { headers: { authorization: "Bearer nope" } })).status === 401);
const good = await fetch(base + "/api/list", { headers: { authorization: "Bearer secret-xyz" } });
ok("GET /api/* with the right token → 200", good.status === 200 && Array.isArray(await good.json()));
ok("GET / (dashboard shell) stays public", (await fetch(base + "/")).status === 200);

// The fleet client sends $PORTBOOK_TOKEN automatically (still "secret-xyz" → matches the server).
process.env.PORTBOOK_SERVER = base;
const client = await import("../src/client.js");
const made = await client.reserve({ project: "a", port: 45990, adopt: true });
ok("client with the matching token can reserve", made.length === 1 && made[0].port === 45990);

// Change only the CLIENT's token; the server already snapshotted the original → mismatch → rejected.
process.env.PORTBOOK_TOKEN = "wrong-now";
let blocked = false; try { await client.list(); } catch { blocked = true; }
ok("client with a mismatched token is rejected", blocked);

srv.close();
fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
