// CLI lifecycle test — `portbook run` (the reserve→inject→release wrapper), `request --wait`,
// `init`, `completion`, and the `log` table. Drives the real bin in a child process against a
// throwaway registry dir, so it exercises argv parsing (the `--` split) end to end.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(root, "bin", "portbook.js");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
// Hermetic env: no fleet server, no WSL probing (speed), our own registry dir.
const env = { ...process.env, PORTBOOK_DIR: DIR, PORTBOOK_NO_WSL: "1" };
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete env[k];

// pexec rejects on nonzero exit — capture instead, since several paths intentionally exit 1.
const cli = (...args) => pexec(process.execPath, [BIN, ...args], { env, timeout: 60000 })
  .then((r) => ({ code: 0, ...r }))
  .catch((e) => ({ code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" }));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// ── portbook run: reserve → inject → run → release, one command ───────────────────────────────────
{
  const r = await cli("run", "--project", "runner", "--range", "46300-46310", "--",
    process.execPath, "-p", "'PORT='+process.env.PORT+' PBP='+process.env.PORTBOOK_PORT+' PROJ='+process.env.PORTBOOK_PROJECT");
  ok("run injects PORT/PORTBOOK_PORT/PORTBOOK_PROJECT", /PORT=46300 PBP=46300 PROJ=runner/.test(r.stdout));
  ok("run reserves then releases around the child", /reserved 46300/.test(r.stderr) && /released 46300/.test(r.stderr));
  ok("run exits 0 on child success", r.code === 0);
  const list = JSON.parse((await cli("list", "--json")).stdout);
  ok("no hold leaks after run", !list.some((x) => x.project === "runner"));
  const log = JSON.parse((await cli("log", "--json", "--port", "46300")).stdout);
  ok("the run lifecycle is on the audit trail", log.some((e) => e.op === "reserve") && log.some((e) => e.op === "release"));
}
{
  const r = await cli("run", "--project", "runner", "--range", "46300-46310", "--", process.execPath, "-e", "process.exit(3)");
  ok("run propagates the child's exit code", r.code === 3);
  ok("run releases even when the child fails", !JSON.parse((await cli("list", "--json")).stdout).some((x) => x.project === "runner"));
}
{
  const r = await cli("run", "--project", "runner");
  ok("run without `--` fails loudly", r.code === 1 && /requires a command after/.test(r.stderr));
  ok("{port} placeholder substitutes in argv", /sub=46305/.test((await cli(
    "run", "--project", "runner", "--port", "46305", "--", process.execPath, "-p", "'sub='+'{port}'")).stdout));
}

// ── request --wait: blocks for the verdict; deny exits 1 with the holder's note ───────────────────
{
  await cli("reserve", "--project", "holder", "--port", "46320");
  await cli("request", "--port", "46320", "--from", "asker", "--reason", "test");
  const inbox = JSON.parse((await cli("inbox", "--json")).stdout);
  const waiter = new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "request", "--port", "46320", "--from", "asker", "--wait", "--timeout", "20"], { env });
    let out = "", errS = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (errS += d));
    p.on("exit", (code) => resolve({ code, out, errS }));
  });
  await new Promise((r) => setTimeout(r, 1200)); // let the waiter file/attach before the verdict lands
  await cli("deny", inbox[0].id, "--note", "still using it");
  const w = await waiter;
  ok("--wait exits nonzero on deny", w.code === 1);
  ok("--wait surfaces the holder's note", /DENIED/.test(w.errS) && /still using it/.test(w.errS));
}
// Grant path: verdict lands first, then --wait's first poll claims the port immediately.
{
  await cli("request", "--port", "46320", "--from", "asker2");
  const q = JSON.parse((await cli("inbox", "--json")).stdout).find((x) => x.fromProject === "asker2");
  await cli("grant", q.id);
  const w = await cli("request", "--port", "46320", "--from", "asker2", "--wait", "--timeout", "20");
  ok("--wait claims a granted port and prints it", w.code === 0 && w.stdout.trim() === "46320");
  const list = JSON.parse((await cli("list", "--json")).stdout);
  ok("the port changed hands in the ledger", list.find((x) => x.port === 46320)?.project === "asker2");
}

// ── list nags the holder about pending asks ───────────────────────────────────────────────────────
{
  await cli("request", "--port", "46320", "--from", "asker3", "--reason", "nag check");
  const l = await cli("list");
  ok("list carries the pending-request nag", /1 pending port request/.test(l.stdout));
}

// ── init: print / append / idempotent ─────────────────────────────────────────────────────────────
{
  const printed = await cli("init");
  ok("init prints the convention", /reserve one\s*$|portbook run --project/m.test(printed.stdout) && /Never kill a process/.test(printed.stdout));
  const target = path.join(DIR, "AGENTS-test.md");
  fs.writeFileSync(target, "# my project\n");
  await cli("init", "--write", "--file", target);
  ok("init --write appends the block", /coordinate through `portbook`/.test(fs.readFileSync(target, "utf8")));
  const again = await cli("init", "--write", "--file", target);
  ok("init --write is idempotent", /already mentions portbook/.test(again.stdout));
}

// ── completion + renew CLI surface ────────────────────────────────────────────────────────────────
{
  ok("completion bash emits a complete rule", /complete -F _portbook portbook/.test((await cli("completion", "bash")).stdout));
  ok("completion pwsh emits an ArgumentCompleter", /Register-ArgumentCompleter/.test((await cli("completion", "pwsh")).stdout));
  ok("completion with no shell fails loudly", (await cli("completion")).code === 1);
  await cli("reserve", "--project", "renewcli", "--port", "46330", "--ttl", "60");
  const r = await cli("renew", "--project", "renewcli", "--ttl", "3600");
  ok("renew CLI reports the extension", /renewed 1 hold/.test(r.stdout));
}

// ── doctor: an unreserved listener inside a project's block is a loud PROBLEM ─────────────────────
{
  await cli("block", "--project", "terr", "--range", "46340-46350");
  const srv = net.createServer().listen(46345);
  await new Promise((r) => srv.once("listening", r));
  const d = await cli("doctor", "--json");
  const j = JSON.parse(d.stdout);
  ok("doctor flags the block intrusion", j.blockIntrusions.some((b) => b.port === 46345) && j.problems.some((p) => /46345/.test(p)));
  ok("doctor exits nonzero when problems exist", d.code === 1);
  ok("doctor json carries the health sections",
    Array.isArray(j.notes) && Array.isArray(j.stale) && Array.isArray(j.wsl) && typeof j.reservations === "number");
  await new Promise((r) => srv.close(r));
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
