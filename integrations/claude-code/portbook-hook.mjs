#!/usr/bin/env node
// portbook PreToolUse hook for Claude Code — the enforcement layer of the port convention.
//
// portbook is cooperative: the OS still hands any port to anyone who asks, so nothing stops an agent
// from binding (or killing!) a port it never reserved. But an agent HARNESS has a real enforcement
// point — hooks. This script inspects each Bash command before it runs and:
//
//   • DENIES commands that would kill/steal a port RESERVED BY ANOTHER PROJECT (kill-port, fuser -k,
//     lsof -ti:PORT piped to kill, or binding it outright) — with the reason pointing the agent at
//     `portbook request`, so the correct next step is one message away.
//   • NUDGES on binding an UNRESERVED port (a warning to the user by default; set
//     PORTBOOK_HOOK_MODE=strict to deny until the agent reserves first).
//   • Stays SILENT for compliant commands — anything that runs `portbook` itself (the reserve-then-
//     bind pattern), ports the current project holds (set PORTBOOK_PROJECT), and everything portless.
//
// Zero dependencies; reads the registry JSON directly (no shell-outs — hooks must be fast) and FAILS
// OPEN: any unexpected state exits 0 with no output, never breaking the user's shell.
//
// Install (see README.md in this directory): add to .claude/settings.json →
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash",
//       "hooks": [ { "type": "command", "command": "node /path/to/portbook-hook.mjs" } ] } ] } }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const registryFile = () =>
  path.join(process.env.PORTBOOK_DIR || path.join(os.homedir(), ".portbook"), "registry.json");

// This machine's reservations, port → row (machine-less rows are local; other machines' aren't ours).
export function localReservations(raw, machine) {
  let reg;
  try { reg = JSON.parse(raw); } catch { return new Map(); }
  const rows = Array.isArray(reg?.reservations) ? reg.reservations : [];
  return new Map(rows.filter((r) => (!r.machine || r.machine === machine) && r.port).map((r) => [r.port, r]));
}

// Extract candidate ports from a shell command, split by intent:
//   kills — the command frees a port by killing whatever holds it
//   binds — the command starts something ON a port
// Deliberately CONSERVATIVE (clear patterns only): a false deny teaches the agent to distrust the
// hook; a miss just means the OS-level collision surfaces the old way.
export function extractPorts(command) {
  const c = String(command);
  const kills = new Set(), binds = new Set();
  const add = (set, m) => { const p = Number(m); if (Number.isInteger(p) && p >= 1024 && p <= 65535) set.add(p); };
  for (const m of c.matchAll(/kill-port(?:\s+--port)?[\s=]+(\d+)/g)) add(kills, m[1]);
  for (const m of c.matchAll(/fuser\s+(?:-[a-zA-Z]*k[a-zA-Z]*\s+)(\d+)/g)) add(kills, m[1]);
  for (const m of c.matchAll(/lsof\s+(?:-[^\s]+\s+)*-t?i\s*:?(\d+)/g)) if (/\bkill\b/.test(c)) add(kills, m[1]);
  for (const m of c.matchAll(/Get-NetTCPConnection[^|;]*-LocalPort\s+(\d+)/g)) if (/Stop-Process|taskkill/i.test(c)) add(kills, m[1]);
  for (const m of c.matchAll(/--port[\s=]+(\d+)/g)) add(binds, m[1]);
  for (const m of c.matchAll(/(?:^|[\s;&|])PORT=(\d+)/g)) add(binds, m[1]);
  for (const m of c.matchAll(/\s-p\s+(\d+):\d+/g)) add(binds, m[1]); // docker-style host:container publish
  for (const p of kills) binds.delete(p); // a port being killed isn't also a bind
  return { kills, binds };
}

// Decide what to answer for one command against the reservations map. Returns null (stay silent) or
// the hook-output object. Exported so the decision table is unit-testable without stdin plumbing.
export function decide(command, reserved, { project = null, mode = "warn" } = {}) {
  const c = String(command);
  if (/(^|[\s;&|($`])portbook(\s|$)/.test(c)) return null; // compliant path — portbook is being used
  const { kills, binds } = extractPorts(c);
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  for (const p of kills) {
    const r = reserved.get(p);
    if (r && r.project !== project) {
      return deny(`Port ${p} is reserved by project "${r.project}"${r.owner ? ` (owner: ${r.owner})` : ""} — do NOT kill it. If you need this port, ask through the ledger: \`portbook request --port ${p} --from <your-project> --reason "<why>" --wait\`, or pick a free one: \`portbook reserve --project <your-project> --count 1\`.`);
    }
  }
  for (const p of binds) {
    const r = reserved.get(p);
    if (r && r.project !== project) {
      return deny(`Port ${p} is reserved by project "${r.project}"${r.owner ? ` (owner: ${r.owner})` : ""} — binding it would collide. Reserve your own port first: \`PORT=$(portbook reserve --project <your-project> --count 1)\`, or negotiate for this one: \`portbook request --port ${p} --from <your-project> --wait\`.`);
    }
    if (!r) {
      if (mode === "strict") {
        return deny(`Port ${p} is not reserved in portbook. Reserve it first so other agents/projects see it: \`portbook reserve --project <your-project> --port ${p} --purpose "<what>"\` — or let portbook pick: \`portbook run --project <your-project> -- <your command>\`. Then retry.`);
      }
      return { systemMessage: `portbook: this command uses port ${p}, which is not reserved — another agent/project may grab or already own it. Prefer \`portbook run --project <name> -- <cmd>\` or reserve it first (see AGENTS.md; set PORTBOOK_HOOK_MODE=strict to enforce).` };
    }
  }
  return null;
}

// ── stdin → decision → stdout (only when this file is executed, not when imported by tests) ───────
async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { return; }
  if (payload?.tool_name !== "Bash") return;
  const command = payload?.tool_input?.command;
  if (!command) return;
  let raw;
  try { raw = fs.readFileSync(registryFile(), "utf8"); } catch { return; } // no registry — nothing to defend
  const reserved = localReservations(raw, process.env.PORTBOOK_MACHINE || os.hostname());
  const out = decide(command, reserved, {
    project: process.env.PORTBOOK_PROJECT || null,
    mode: (process.env.PORTBOOK_HOOK_MODE || "warn").toLowerCase(),
  });
  if (out) process.stdout.write(JSON.stringify(out));
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { /* fail open — a broken hook must never block the shell */ });
}
