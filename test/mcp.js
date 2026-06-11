// Tests for the MCP stdio server — drives it in-process over two PassThrough streams (no real stdio,
// no child process). Runs against a throwaway registry dir so it needs no live ports or containers:
// the ecosystem tool is exercised for shape only. Same style/harness as test/smoke.js.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PassThrough } from "node:stream";

// A machine configured per docs/FLEET.md exports these in the shell profile — they must never leak
// into the suite (PORTBOOK_MACHINE would also break the machine assertions below). Scrub BEFORE
// importing any src module.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];

process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-mcp-test-"));
const { runMcpServer } = await import("../src/mcp.js");
const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
const callResult = (msg) => JSON.parse(msg.result.content[0].text); // tools/call replies carry JSON as text

// 1) initialize
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
const init = await next();
ok("initialize returns serverInfo.name === portbook", init.result?.serverInfo?.name === "portbook");
ok("initialize reports the real package version", init.result?.serverInfo?.version === PKG.version);
ok("initialize echoes a supported protocolVersion", init.result?.protocolVersion === "2024-11-05");
ok("initialize advertises tools capability", !!init.result?.capabilities?.tools);
ok("initialize echoes the id", init.id === 1);

// An unknown protocol revision must NOT be parroted back — answer with our own instead.
send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-12-31" } });
const badProto = await next();
ok("unknown protocolVersion falls back to ours, not the client's", badProto.result?.protocolVersion === "2024-11-05");
send({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-03-26" } });
ok("a later supported revision is echoed", (await next()).result?.protocolVersion === "2025-03-26");

// A notification must NOT produce a response — verified implicitly by the id ordering below.
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// 2) tools/list
send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
const listed = await next();
const names = (listed.result?.tools || []).map((t) => t.name);
ok("tools/list responds to the right id (notification produced no reply)", listed.id === 4);
ok("tools/list contains reserve and ecosystem", names.includes("reserve") && names.includes("ecosystem"));
ok("tools/list contains the block territory tools", ["reserve_block", "list_blocks", "release_block"].every((n) => names.includes(n)));
ok("each tool has an object inputSchema", (listed.result?.tools || []).every((t) => t.inputSchema?.type === "object"));

// 3) tools/call name="ecosystem"
send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ecosystem", arguments: {} } });
const called = await next();
ok("tools/call ecosystem returns text content", called.result?.content?.[0]?.type === "text");
let eco = null; try { eco = callResult(called); } catch { /* leave null */ }
ok("ecosystem result JSON-parses to an object with a ports array", !!eco && Array.isArray(eco.ports));

// 4) unknown method with an id -> JSON-RPC error
send({ jsonrpc: "2.0", id: 6, method: "does/not/exist" });
const unknown = await next();
ok("unknown method returns error code -32601", unknown.error?.code === -32601);

// 5) undeclared arguments are filtered out before dispatch — a client must not be able to smuggle
// registry-only fields (machine forges attribution, probe:false skips the OS check, host -> DNS).
send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "reserve", arguments: {
  project: "mcp-smuggle", purpose: "filter test", rangeStart: 45230, rangeEnd: 45260,
  machine: "evil-box", probe: false, host: "127.0.0.1" } } });
const made = callResult(await next());
ok("smuggled machine is ignored — reservation is attributed locally", made[0]?.machine === os.hostname());
ok("smuggled host is ignored — record keeps the default", made[0]?.host === "*");
ok("declared args still pass through (purpose)", made[0]?.purpose === "filter test");
send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "release", arguments: { project: "mcp-smuggle" } } });
ok("release by project frees the smuggle-test hold", callResult(await next()) === 1);

// 6) block territory round-trip: reserve_block -> list_blocks -> release_block
send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "reserve_block", arguments: {
  project: "mcp-blocks", rangeStart: 45810, rangeEnd: 45819, owner: "mcp-test", purpose: "territory" } } });
const block = callResult(await next());
ok("reserve_block returns the block row", !!block?.id && block.project === "mcp-blocks" && block.rangeStart === 45810 && block.rangeEnd === 45819);
send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_blocks", arguments: { project: "mcp-blocks" } } });
const blocks = callResult(await next());
ok("list_blocks shows the claimed block", blocks.length === 1 && blocks[0].id === block.id && blocks[0].owner === "mcp-test");
send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "release_block", arguments: { project: "mcp-blocks" } } });
ok("release_block releases it and returns the count", callResult(await next()) === 1);
send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "list_blocks", arguments: {} } });
ok("the block is gone after release", callResult(await next()).length === 0);
send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "release_block", arguments: {} } });
const noSel = await next();
ok("release_block with no selector is a tool error", noSel.result?.isError === true);

// 7) JSON-RPC batches: each element answered, replies emitted as ONE array (was: silently dropped)
send([
  { jsonrpc: "2.0", id: 20, method: "ping" },
  { jsonrpc: "2.0", method: "notifications/initialized" }, // notification inside a batch: no reply
  { jsonrpc: "2.0", id: 21, method: "tools/list" },
]);
const batch = await next();
ok("a batch gets an array response", Array.isArray(batch) && batch.length === 2);
ok("batch replies carry the right ids in order", batch?.[0]?.id === 20 && batch?.[1]?.id === 21);
send([]); // empty batch is invalid per JSON-RPC 2.0
const empty = await next();
ok("an empty batch returns -32600 with null id", empty.error?.code === -32600 && empty.id === null);
send([{ jsonrpc: "2.0", method: "notifications/initialized" }]); // all-notification batch: silence
send({ jsonrpc: "2.0", id: 22, method: "ping" });
ok("a notification-only batch produces no reply", (await next()).id === 22);

input.end(); // ends the server's input stream -> runMcpServer resolves
await done;

// 8) abrupt harness death: a stream 'error' (what a real stdio Socket emits on EPIPE/read failure)
// must resolve the server, not crash the process with an unhandled 'error' event.
{
  const in2 = new PassThrough(), out2 = new PassThrough();
  const done2 = runMcpServer({ input: in2, output: out2 });
  out2.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  in2.emit("error", Object.assign(new Error("read after close"), { code: "EBADF" }));
  await done2;
  ok("stream 'error' events resolve the server instead of crashing", true);
}
// 9) a reply written after the output side is destroyed is swallowed, never thrown
{
  const in3 = new PassThrough(), out3 = new PassThrough();
  const done3 = runMcpServer({ input: in3, output: out3 });
  out3.destroy();
  in3.write(JSON.stringify({ jsonrpc: "2.0", id: 90, method: "ping" }) + "\n");
  await new Promise((r) => setTimeout(r, 30)); // let the handler chain attempt the write
  in3.end();
  await done3;
  ok("a write to a destroyed output stream is survived", true);
}

fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
