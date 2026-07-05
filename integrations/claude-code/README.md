# portbook × Claude Code — hook enforcement

Two integrations live here:

1. **MCP tools** (recommended for driving portbook): `claude mcp add portbook -- portbook mcp` — see
   [integrations/mcp/](../mcp/).
2. **The PreToolUse hook** (this directory): actual *enforcement* of the port convention. portbook is
   cooperative — the OS still gives any port to anyone — but the agent harness has a real enforcement
   point: hooks. [`portbook-hook.mjs`](./portbook-hook.mjs) inspects every Bash command before it runs
   and blocks the two behaviors the registry exists to prevent.

## What it does

| Command pattern | Port state | Result |
|---|---|---|
| `npx kill-port 4100`, `fuser -k 4100`, `lsof -ti:4100 … kill`, PowerShell `Get-NetTCPConnection -LocalPort 4100` + `Stop-Process` | reserved by **another project** | **denied**, with the `portbook request … --wait` escape hatch in the reason |
| `--port 4100`, `PORT=4100 …`, `docker … -p 4100:80` | reserved by **another project** | **denied** — binding it would collide; reason says how to reserve/negotiate |
| same bind patterns | **not reserved** | warning to the user (default), or **denied** with reserve-first instructions when `PORTBOOK_HOOK_MODE=strict` |
| anything that runs `portbook` itself; ports your own project holds; commands with no ports | — | silent |

The hook is deliberately conservative (clear patterns only), reads the registry file directly (no
shell-outs — it adds ~30 ms, not seconds), and **fails open**: any unexpected state exits silently
rather than breaking your shell.

## Install

Add to your project's `.claude/settings.json` (or `~/.claude/settings.json` for every project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node C:/dev/github/portbook/integrations/claude-code/portbook-hook.mjs" }
        ]
      }
    ]
  }
}
```

(Use your checkout's path, or copy the single file anywhere — it has zero dependencies. If portbook
was installed via `npm install -g portbook`, the file lives under the global
`node_modules/portbook/integrations/claude-code/`.)

## Tuning (environment variables on the Claude Code process)

- `PORTBOOK_PROJECT=<name>` — the project this session works on; its **own** reserved ports pass
  silently. (`portbook run` sets this automatically for its children.)
- `PORTBOOK_HOOK_MODE=strict` — also deny binds on *unreserved* ports until the agent reserves first
  (default `warn` only notifies the user).
- `PORTBOOK_DIR` / `PORTBOOK_MACHINE` — same meaning as for the CLI.
