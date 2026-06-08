# portbook integrations

How to wire portbook into the tools you already use. Everything below talks to the **same**
machine-wide registry (`~/.portbook/registry.json`, override with `PORTBOOK_DIR`) — pick whichever
surface fits the tool:

| You're using…                              | Use this surface              | Lives in                              |
|--------------------------------------------|-------------------------------|---------------------------------------|
| An MCP agent (Claude Code, Codex, Cursor, Windsurf, Hermes) | **MCP server** (`portbook mcp`) | [`integrations/mcp/`](../integrations/mcp/)         |
| VS Code (or Cursor / Windsurf, both VS Code forks) | **VS Code extension**         | [`integrations/vscode/`](../integrations/vscode/)   |
| Zed                                        | **Zed tasks** (CLI)           | [`integrations/zed/`](../integrations/zed/)         |
| JetBrains IDEs (IntelliJ, WebStorm, …)     | **External Tools** (CLI)      | [`integrations/jetbrains/`](../integrations/jetbrains/) |
| Anything else / scripts / dashboards       | **HTTP API + CLI**            | `portbook serve` · `portbook` on PATH |

All of these are thin clients over the **zero-dependency** core (`src/registry.js` +
`src/environments.js`). None of them change the registry's behavior — they just surface
reserve / release / list / check / scan / ecosystem / gc where you work. The etiquette every agent
should follow (reserve before you bind, release on stop, record the PID) is in
[AGENTS.md](../AGENTS.md).

## MCP server

For any **MCP-aware** harness. The client spawns `portbook mcp` and talks
newline-delimited JSON-RPC 2.0 over stdio; the server exposes seven tools —
`reserve`, `release`, `list`, `check`, `scan`, `ecosystem`, `gc` — mirroring the library and HTTP
APIs.

Ready-to-copy config and per-harness setup blocks (Claude Code, Codex, Cursor, Windsurf, Hermes, and
a generic stdio entry) are in **[integrations/mcp/](../integrations/mcp/)**:
- [`mcp.json`](../integrations/mcp/mcp.json) — the canonical `{ "mcpServers": { "portbook": … } }` block.
- [`README.md`](../integrations/mcp/README.md) — where each client's config lives and how to add it
  (including `claude mcp add portbook -- portbook mcp`).

## VS Code extension (and Cursor / Windsurf)

A status-bar + command-palette surface for the registry inside the editor:
**[integrations/vscode/](../integrations/vscode/)**.

Because **Cursor** and **Windsurf** are VS Code forks, the same extension loads in them — install the
VSIX through their extensions view. (If you'd rather drive portbook as an *agent* tool in Cursor or
Windsurf, use the [MCP server](#mcp-server) instead; the two are complementary — the extension is for
you, MCP is for the agent.)

## Zed

Zed **tasks** that run portbook from the command palette (Zed's extension API can't render a custom
panel yet, so tasks + CLI is the pragmatic surface): **[integrations/zed/](../integrations/zed/)**.
See that folder's README for install and configuration.

## JetBrains

**External Tools** entries for IntelliJ-platform IDEs (IntelliJ IDEA, WebStorm, PyCharm, …):
**[integrations/jetbrains/](../integrations/jetbrains/)**. See that folder's README for install and
configuration.

## Raw HTTP API + CLI

For anything without a dedicated integration — shell scripts, CI, a custom dashboard, another
language — talk to portbook directly.

### CLI

`portbook` is on your `PATH` after `npm link`. Add `--json` to `reserve`/`list`/`scan`/`env` for
machine-readable output (`check` is always JSON):

```bash
PORT=$(portbook reserve --project myapp --count 1 --owner agent)   # capture a free port
portbook list --json | jq '.[] | select(.bound==false)'           # reserved but not listening
portbook check 4100                                                # reserved? OS-free? (JSON)
portbook scan --json                                               # everything listening here
```

Full command reference: `portbook help`, or the [README](../README.md#use).

### HTTP API

`portbook serve` starts a zero-dependency HTTP server (default `http://127.0.0.1:7800`, change with
`--port` / `--bind`). Responses are JSON; CORS is permissive (`Access-Control-Allow-Origin: *`) so a
browser dashboard can call it.

| Method & path           | Body / params                         | Returns |
|-------------------------|---------------------------------------|---------|
| `GET /`                 | —                                     | the live HTML dashboard |
| `GET /api/ecosystem`    | —                                     | whole-machine view (host + containers + WSL) |
| `GET /api/scan`         | —                                     | listening: managed / unmanaged / ghosts |
| `GET /api/list`         | `?project=<name>` (optional)          | reservations (annotated with live state) |
| `GET /api/check/:port`  | port in path                          | `{ port, reservation, osFree }` |
| `GET /api/fleet`        | —                                     | every machine's reservations + each machine's latest report |
| `POST /api/reserve`     | JSON body = reserve opts (`project` required; `machine`/`probe` for fleet) | the reservation(s) made |
| `POST /api/release`     | JSON body `{ port | project | id, machine? }` | count released |
| `POST /api/gc`          | —                                     | reclaimed (stale) reservations |
| `POST /api/report`      | JSON body `{ machine, ecosystem }`    | `{ ok, machines }` — a machine pushes its ecosystem to the fleet view |

```bash
portbook serve --bind 127.0.0.1 --port 7800 &
curl -s http://127.0.0.1:7800/api/scan | jq .
curl -s -X POST http://127.0.0.1:7800/api/reserve \
  -H 'content-type: application/json' \
  -d '{"project":"myapp","count":1,"owner":"ci"}'
```

> Binding `portbook serve` to a Tailscale IP (`--bind`) is also the foundation of cross-machine
> **fleet mode** — see [docs/FLEET.md](./FLEET.md).
