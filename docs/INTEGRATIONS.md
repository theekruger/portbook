# portbook integrations

How to wire portbook into the tools you already use. Everything below talks to the **same**
machine-wide registry (`~/.portbook/registry.json`, override with `PORTBOOK_DIR`) — pick whichever
surface fits the tool:

| You're using…                              | Use this surface              | Lives in                              |
|--------------------------------------------|-------------------------------|---------------------------------------|
| An MCP agent (Claude Code, Codex, Cursor, Windsurf, Hermes) | **MCP server** (`portbook mcp`) | [`integrations/mcp/`](../integrations/mcp/)         |
| VS Code (or Cursor / Windsurf, both VS Code forks) | **VS Code extension**         | [`integrations/vscode/`](../integrations/vscode/)   |
| Zed                                        | **MCP (Agent Panel)** + tasks | [`integrations/zed/`](../integrations/zed/)         |
| JetBrains IDEs (IntelliJ, WebStorm, …)     | **External Tools** (CLI)      | [`integrations/jetbrains/`](../integrations/jetbrains/) |
| Anything else / scripts / dashboards       | **HTTP API + CLI**            | `portbook serve` · `portbook` on PATH |

All of these are thin clients over the **zero-dependency** core (`src/registry.js` +
`src/environments.js`). None of them change the registry's behavior — they just surface
reserve / release / list / check / scan / ecosystem / gc (plus port-territory blocks and
request/grant **negotiation**) where you work. The etiquette every agent
should follow (reserve before you bind, release on stop, record the PID, ask — never kill — when a
port you want is held) is in [AGENTS.md](../AGENTS.md).

## Adopting portbook in a harness you don't control

portbook never needs to be *baked into* a harness or approved by its vendor — it attaches from the
outside, through configuration you already own. In rough order of preference:

1. **MCP (works almost everywhere).** MCP servers are **user-configured**, not vendor-shipped: drop
   the [`mcp.json`](../integrations/mcp/mcp.json) block into the harness's MCP settings and it gains
   portbook's fifteen tools — no cooperation from the harness's author required. Claude Code, Codex,
   Cursor, Windsurf, Copilot CLI, and effectively every modern agent harness speak MCP.
2. **ACP editors get it for free, via MCP.** The [Agent Client Protocol](https://agentclientprotocol.com)
   connects editors (Zed, JetBrains AI Assistant, Neovim plugins) to any ACP agent — and when an ACP
   session starts, **the editor passes its configured MCP servers through to the agent**. portbook
   stays at the tool layer (MCP) and ACP carries it into whatever agent connects; portbook does not
   need to speak ACP itself.
3. **Instruction files, for convention-following.** Harnesses that read `AGENTS.md` / `CLAUDE.md` /
   global rules will follow the *reserve-before-bind* convention with the plain CLI, even with no MCP
   at all. Drop the rule from [AGENTS.md](../AGENTS.md) into your global agent instructions
   (e.g. `~/.claude/CLAUDE.md`, Windsurf's `global_rules.md`).
4. **CLI + HTTP, the universal floor.** Any harness that can run a shell command can
   `portbook reserve … --json`; anything that can only make web requests can use the
   [HTTP API](#http-api) from `portbook serve`. No integration code anywhere.

One honest caveat applies to all four: portbook is a *cooperative* convention (see
[Limitations](../README.md#limitations)) — these paths make it available to a foreign harness, and the
instruction layer makes it *likely* to be followed, but nothing forces a process to reserve before it
binds.

## MCP server

For any **MCP-aware** harness. The client spawns `portbook mcp` and talks
newline-delimited JSON-RPC 2.0 over stdio; the server exposes fifteen tools —
`reserve`, `release`, `list`, `check`, `scan`, `ecosystem`, `gc`, the block-territory tools
`reserve_block`, `list_blocks`, `release_block`, and the port-negotiation tools `request_port`,
`inbox`, `my_requests`, `grant_request`, `deny_request` (ask for a held port; the holder grants —
releasing the hold, or opening a one-shot exemption through its block — or denies with a note) —
mirroring the library and HTTP APIs.

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

`portbook` is on your `PATH` after `npm link`. Add `--json` to `reserve`/`list`/`blocks`/`scan`/`env`
— and the negotiation commands `request`/`inbox`/`requests`/`grant`/`deny` — for machine-readable
output (`check` is always JSON). `list --json` is always a plain **array** of
reservations — port territories have their own surface, `portbook blocks --json`:

```bash
PORT=$(portbook reserve --project myapp --count 1 --owner agent)   # capture a free port
portbook list --json | jq '.[] | select(.bound==false)'           # reserved but not listening
portbook blocks --json                                             # port-territory blocks
portbook check 4100                                                # reserved? OS-free? (JSON)
portbook scan --json                                               # everything listening here
```

Full command reference: `portbook help`, or the [README](../README.md#use).

### HTTP API

`portbook serve` starts a zero-dependency HTTP server (default `http://127.0.0.1:7800`, change with
`--port` / `--bind`). Responses are JSON; CORS is permissive (`Access-Control-Allow-Origin: *`) so a
browser dashboard can call it.

| Method & path              | Body / params                         | Returns |
|----------------------------|---------------------------------------|---------|
| `GET /`                    | —                                     | the live HTML dashboard |
| `GET /api/ecosystem`       | —                                     | whole-machine view (host + containers + WSL) |
| `GET /api/scan`            | —                                     | listening: managed / unmanaged / ghosts |
| `GET /api/list`            | `?project=<name>`, `?raw=1` (both optional) | reservations annotated with live state; `raw=1` skips annotation (fleet clients annotate against their own OS) |
| `GET /api/check/:port`     | port in path                          | `{ port, reservation, osFree }` |
| `GET /api/fleet`           | —                                     | `{ server, at, reservations, blocks, reports }` — every machine's holds + latest reports |
| `GET /api/blocks`          | `?project=<name>` (optional)          | port-territory blocks (every machine's) |
| `GET /api/requests`        | `?project=<name>` → that project's pending **inbox**; `?from=<name>` (alone — `?project=` wins if both are sent) → that requester's **outbox** (all statuses, newest first); `?machine=<m>` scopes the inbox (fleet clients pass their own); no params → every pending ask | pending requests / the requester's filings |
| `POST /api/reserve`        | JSON body = reserve opts (`project` required; `machine`/`probe` for fleet) | the reservation(s) made |
| `POST /api/release`        | JSON body `{ port \| project \| id, machine? }` | `{ released: <count> }` |
| `POST /api/blocks`         | JSON body `{ project, rangeStart, rangeEnd, owner?, purpose?, machine? }` | the block made |
| `POST /api/blocks/release` | JSON body `{ id \| project, machine? }` | `{ released: <count> }` |
| `POST /api/requests`       | JSON body `{ port, fromProject, fromOwner?, reason?, machine? }` — ask for a **held** port instead of clobbering | the request filed (`status: "pending"`; re-filing an identical pending ask returns the existing row) |
| `POST /api/requests/resolve` | JSON body `{ id, action: "grant" \| "deny", note? }` — the holder answers an ask from its inbox | the resolved request, plus `releasedReservation` (a grant released the holder's reservation vs. issued a one-shot block exemption) |
| `POST /api/gc`             | —                                     | `{ reclaimed: <count> }` — a count (the library/MCP `gc` return the removed entries instead) |
| `POST /api/report`         | JSON body `{ machine, ecosystem }`    | `{ ok, machines }` — a machine pushes its ecosystem to the fleet view |

```bash
portbook serve --bind 127.0.0.1 --port 7800 &
curl -s http://127.0.0.1:7800/api/scan | jq .
curl -s -X POST http://127.0.0.1:7800/api/reserve \
  -H 'content-type: application/json' \
  -d '{"project":"myapp","count":1,"owner":"ci"}'
```

> Binding `portbook serve` to a Tailscale IP (`--bind`) is also the foundation of cross-machine
> **fleet mode** — see [docs/FLEET.md](./FLEET.md).
