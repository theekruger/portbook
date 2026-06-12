# portbook MCP server

Expose the portbook port registry to any **MCP-aware** coding agent (Claude Code, Codex, Cursor,
Windsurf, Hermes, …) so the agent reserves/releases ports through the same machine-wide source of
truth a human uses from the CLI. No collisions, no hardcoded ports.

## How harnesses launch it

Every MCP client starts the server the same way — it spawns a child process and talks to it over
**stdio**:

- **command:** `portbook`
- **args:** `["mcp"]`
- **transport:** stdio — newline-delimited [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  (one JSON message per line) on stdin/stdout. No port, no HTTP. (For an HTTP/browser surface, run
  `portbook serve` instead — see the [HTTP API](../../docs/INTEGRATIONS.md#raw-http-api--cli).)

`portbook` must be on the `PATH` the harness inherits (`npm link`, or a global install). If a client
can't find it, point `command` at the absolute path to the `portbook` executable instead.

### Tools exposed

The server advertises these tools (names and shapes mirror the [library API](../../README.md#programmatic-use)
and the [HTTP API](../../docs/INTEGRATIONS.md#raw-http-api--cli) one-for-one):

| Tool        | Does                                                          | Key arguments |
|-------------|--------------------------------------------------------------|---------------|
| `reserve`   | Reserve a specific port or auto-pick free one(s) in a range. | `project` (required), `port`, `count`, `purpose`, `owner`, `pid`, `ttlSec`, `rangeStart`, `rangeEnd`, `adopt` |
| `release`   | Release reservation(s) by project, port, or id.              | one of `project` \| `port` \| `id` |
| `list`      | Reserved ports (optionally filtered) + live bound/stale state.| `project` |
| `check`     | Is a port reserved and/or OS-free right now?                 | `port` (required) |
| `scan`      | What's actually listening here: managed / unmanaged / ghosts.| — |
| `ecosystem` | Whole-machine view: host ports + containers + WSL.           | — |
| `gc`        | Reclaim dead-PID / expired reservations.                     | — |

**Port territory** (claim a range per project — see the [README](../../README.md#port-territory-blocks)):

| Tool            | Does                                                       | Key arguments |
|-----------------|------------------------------------------------------------|---------------|
| `reserve_block` | Claim a contiguous port range as a project's territory.    | `project`, `rangeStart`, `rangeEnd` (all required), `owner`, `purpose` |
| `release_block` | Release block(s) by id or project.                         | one of `id` \| `project` |
| `list_blocks`   | List port-territory blocks (optionally one project's).     | `project` |

**Negotiation** (a port you need is held by another project — *ask* instead of killing it; see
[CUBICLES.md](../../docs/CUBICLES.md)):

| Tool            | Does                                                        | Key arguments |
|-----------------|-------------------------------------------------------------|---------------|
| `request_port`  | File a request against the project holding a port.         | `port`, `fromProject` (required), `fromOwner`, `reason` |
| `inbox`         | Pending requests targeting your project's holds.           | `project` |
| `my_requests`   | Requests *you* filed, with their grant/deny status.        | `fromProject` (required) |
| `grant_request` | Grant: releases the holder's reservation (held for the requester) or issues a one-shot block exemption. | `id` (required), `note` |
| `deny_request`  | Deny, with an optional explanatory note.                   | `id` (required), `note` |

> Reservation etiquette for agents (reserve before you bind, release on stop, record the PID, ask
> instead of kill) is in the top-level [AGENTS.md](../../AGENTS.md).

## Client configuration

### Claude Code

Project-scoped: drop a `.mcp.json` at the repo root (commit it so teammates inherit the server). This
is the same content as [`mcp.json`](./mcp.json) in this folder:

```json
{
  "mcpServers": {
    "portbook": {
      "command": "portbook",
      "args": ["mcp"]
    }
  }
}
```

Or add it from the CLI (no file editing):

```bash
claude mcp add portbook -- portbook mcp
```

Everything after `--` is the launch command, so this registers `command: "portbook"`,
`args: ["mcp"]`. Add `-s user` to register it for every project instead of just this one.

### Codex

Codex reads MCP servers from its config TOML (typically `~/.codex/config.toml`). Add a
`[mcp_servers.portbook]` table:

```toml
[mcp_servers.portbook]
command = "portbook"
args = ["mcp"]
```

### Cursor

Cursor stores MCP servers as JSON. Use **`.cursor/mcp.json`** in the project root (project scope) or
**`~/.cursor/mcp.json`** (global scope). Same schema as Claude Code:

```json
{
  "mcpServers": {
    "portbook": {
      "command": "portbook",
      "args": ["mcp"]
    }
  }
}
```

You can also add it via Cursor → Settings → MCP → *Add new MCP server* (Type: `command`,
Command: `portbook mcp`).

### Windsurf

Windsurf (Cascade) keeps its MCP config at **`~/.codeium/windsurf/mcp_config.json`**. Same
`mcpServers` shape:

```json
{
  "mcpServers": {
    "portbook": {
      "command": "portbook",
      "args": ["mcp"]
    }
  }
}
```

Edit it via Windsurf → Settings → Cascade → *Manage MCP servers* → *Add server* (raw config), then
hit refresh so Cascade reconnects.

### Hermes / any other stdio client

Any MCP client that speaks stdio can launch portbook with the generic entry below — this is the
portable form; consult your client's docs for *where* its server list lives:

```json
{
  "mcpServers": {
    "portbook": {
      "command": "portbook",
      "args": ["mcp"]
    }
  }
}
```

Clients that take a flat command line rather than a JSON block want simply:

```
portbook mcp
```

## Troubleshooting

- **`portbook: command not found` from the client** — the harness's `PATH` doesn't include the bin.
  Run `portbook where` in a normal shell to confirm it's installed, then either fix `PATH` or set
  `command` to the absolute path of the executable.
- **Sanity-check the transport by hand** — the server reads one JSON-RPC message per line on stdin:
  ```bash
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | portbook mcp
  ```
  You should get a one-line JSON response listing the tools above.
- **No tools appear** — make sure the client actually restarted/refreshed the server after you edited
  its config; most cache the connection.
