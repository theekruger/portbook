// Tests for the MCP stdio server — drives it in-process over two PassThrough streams (no real stdio,
// no child process). Runs against a throwaway registry dir so it needs no live ports or containers:
// the ecosystem tool is exercised for shape only. Same style/harness as test/smoke.js.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PassThrough } from "node:stream";

process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-mcp-test-"));
const { runMcpServer } = await import("../src/mcp.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// Wire the server to a pair of pipes: we write requests into `input`, read responses from `output`.
const input = new PassThrough();
const output = new PassThrough();
output.setEncoding("utf8");
const done = runMcpServer({ input, output });

// Collect newline-delimited responses, resolving each waiter as a full line arrives. A message goes
// to a parked waiter OR onto the queue — never both, or it would be delivered twice.
const responses = [];
const waiters = [];
let obuf = "";
output.on("data", (chunk) => {
  obuf += chunk;
  let nl;
  while ((nl = obuf.indexOf("\n")) !== -1) {
    const line = obuf.slice(0, nl).trim();
    obuf = obuf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = waiters.shift();
    if (w) w(msg); else responses.push(msg);
  }
});
const send = (msg) => input.write(JSON.stringify(msg) + "\n");
const next = () => new Promise((r) => (responses.length ? r(responses.shift()) : waiters.push(r)));

// 1) initialize
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
const init = await next();
ok("initialize returns serverInfo.name === portbook", init.result?.serverInfo?.name === "portbook");
ok("initialize advertises tools capability", !!init.result?.capabilities?.tools);
ok("initialize echoes the id", init.id === 1);

// A notification must NOT produce a response — verified implicitly by the id ordering below.
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// 2) tools/list
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const listed = await next();
const names = (listed.result?.tools || []).map((t) => t.name);
ok("tools/list responds to the right id (notification produced no reply)", listed.id === 2);
ok("tools/list contains reserve and ecosystem", names.includes("reserve") && names.includes("ecosystem"));
ok("each tool has an object inputSchema", (listed.result?.tools || []).every((t) => t.inputSchema?.type === "object"));

// 3) tools/call name="ecosystem"
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ecosystem", arguments: {} } });
const called = await next();
ok("tools/call ecosystem returns text content", called.result?.content?.[0]?.type === "text");
let eco = null; try { eco = JSON.parse(called.result.content[0].text); } catch { /* leave null */ }
ok("ecosystem result JSON-parses to an object with a ports array", !!eco && Array.isArray(eco.ports));

// 4) unknown method with an id -> JSON-RPC error
send({ jsonrpc: "2.0", id: 4, method: "does/not/exist" });
const unknown = await next();
ok("unknown method returns error code -32601", unknown.error?.code === -32601);

input.end(); // ends the server's input stream -> runMcpServer resolves
await done;

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
