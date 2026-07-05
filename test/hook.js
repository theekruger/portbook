// Claude Code PreToolUse hook test — the enforcement layer (integrations/claude-code). Two halves:
//   1) the exported decision table (extractPorts/decide), hermetic on any OS;
//   2) the real script end-to-end: spawned with a PreToolUse payload on stdin against a throwaway
//      registry, asserting deny/warn/silence and that a broken world always FAILS OPEN (exit 0).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(root, "integrations", "claude-code", "portbook-hook.mjs");
const { extractPorts, decide, localReservations } = await import(new URL("../integrations/claude-code/portbook-hook.mjs", import.meta.url));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const me = os.hostname();

// ── 1a. port extraction: kills vs binds, conservative on noise ────────────────────────────────────
{
  ok("kill-port / fuser -k / lsof+kill are kills", (() => {
    const a = extractPorts("npx kill-port 4100");
    const b = extractPorts("fuser -k 4100/tcp"); // trailing /tcp
    const c = extractPorts("kill -9 $(lsof -ti:4100)");
    return a.kills.has(4100) && b.kills.has(4100) && c.kills.has(4100);
  })());
  ok("PowerShell Get-NetTCPConnection + Stop-Process is a kill",
    extractPorts('Stop-Process -Id (Get-NetTCPConnection -LocalPort 4100).OwningProcess').kills.has(4100));
  ok("lsof WITHOUT kill is not a kill", !extractPorts("lsof -ti:4100").kills.has(4100));
  ok("--port / PORT= / docker -p are binds", (() => {
    const a = extractPorts("vite --port 5173");
    const b = extractPorts("PORT=3000 npm start");
    const c = extractPorts("docker run -p 8080:80 nginx");
    return a.binds.has(5173) && b.binds.has(3000) && c.binds.has(8080);
  })());
  ok("privileged/absurd ports are ignored", !extractPorts("--port 80").binds.size && !extractPorts("--port 99999").binds.size);
  ok("REPORT=5 style vars are not PORT=", !extractPorts("REPORT=5000 cmd").binds.size);
}

// ── 1b. the decision table ─────────────────────────────────────────────────────────────────────────
{
  const reserved = new Map([[4100, { port: 4100, project: "api", owner: "claude" }]]);
  const denied = (d) => d?.hookSpecificOutput?.permissionDecision === "deny";
  ok("killing another project's port is denied, pointing at `portbook request`",
    denied(decide("npx kill-port 4100", reserved)) && /portbook request/.test(decide("npx kill-port 4100", reserved).hookSpecificOutput.permissionDecisionReason));
  ok("binding another project's port is denied", denied(decide("vite --port 4100", reserved)));
  ok("your OWN project's port passes silently", decide("vite --port 4100", reserved, { project: "api" }) === null);
  ok("an unreserved bind warns by default (systemMessage, no deny)", (() => {
    const d = decide("vite --port 5173", reserved);
    return d && !d.hookSpecificOutput && /not reserved/.test(d.systemMessage);
  })());
  ok("strict mode denies the unreserved bind with reserve-first instructions", (() => {
    const d = decide("vite --port 5173", reserved, { mode: "strict" });
    return denied(d) && /portbook reserve/.test(d.hookSpecificOutput.permissionDecisionReason);
  })());
  ok("commands running portbook itself are exempt",
    decide("PORT=$(portbook reserve --project x --count 1) && vite --port 4100", reserved) === null);
  ok("portless commands are silent", decide("git status", reserved) === null);
  ok("localReservations scopes to this machine", (() => {
    const raw = JSON.stringify({ reservations: [
      { port: 1, project: "a", machine: me }, { port: 2, project: "b" }, { port: 3, project: "c", machine: "elsewhere" },
    ] });
    const m = localReservations(raw, me);
    return m.has(1) && m.has(2) && !m.has(3);
  })());
  ok("corrupt registry JSON → empty map (fail open)", localReservations("{nope", me).size === 0);
}

// ── 2. the real script over stdin ──────────────────────────────────────────────────────────────────
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-test-"));
fs.writeFileSync(path.join(DIR, "registry.json"), JSON.stringify({
  version: 1, reservations: [{ id: "x", port: 4100, project: "api", owner: "claude", machine: me }],
  blocks: [], requests: [], origins: [],
}));
const runHook = (payload, extraEnv = {}) => new Promise((resolve) => {
  const env = { ...process.env, PORTBOOK_DIR: DIR, ...extraEnv };
  delete env.PORTBOOK_MACHINE; delete env.PORTBOOK_PROJECT;
  const p = spawn(process.execPath, [HOOK], { env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("exit", (code) => resolve({ code, out }));
  p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
});
{
  const r = await runHook({ tool_name: "Bash", tool_input: { command: "npx kill-port 4100" } });
  const j = JSON.parse(r.out);
  ok("e2e: kill of a reserved port → deny JSON on stdout, exit 0",
    r.code === 0 && j.hookSpecificOutput.permissionDecision === "deny" && /api/.test(j.hookSpecificOutput.permissionDecisionReason));
  const quiet = await runHook({ tool_name: "Bash", tool_input: { command: "git status" } });
  ok("e2e: harmless command → no output", quiet.code === 0 && quiet.out === "");
  const notBash = await runHook({ tool_name: "Read", tool_input: { file_path: "x" } });
  ok("e2e: non-Bash tools are ignored", notBash.code === 0 && notBash.out === "");
  const strict = await runHook({ tool_name: "Bash", tool_input: { command: "vite --port 5199" } }, { PORTBOOK_HOOK_MODE: "strict" });
  ok("e2e: strict mode denies an unreserved bind", JSON.parse(strict.out).hookSpecificOutput.permissionDecision === "deny");
  const garbage = await runHook("not json at all");
  ok("e2e: garbage stdin fails open (exit 0, silent)", garbage.code === 0 && garbage.out === "");
  const noReg = await runHook({ tool_name: "Bash", tool_input: { command: "npx kill-port 4100" } }, { PORTBOOK_DIR: path.join(DIR, "missing") });
  ok("e2e: missing registry fails open", noReg.code === 0 && noReg.out === "");
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
