# portbook × Zed

Two complementary surfaces:

- **Agent Panel via MCP (recommended)** — Zed speaks the Model Context Protocol, so its AI agent can
  drive portbook directly: reserve before binding, check/scan, claim territory, and answer port
  requests — all as first-class tools.
- **Tasks** — one-keystroke `portbook` commands for *you*, in an integrated terminal.

> Prereq for both: the `portbook` CLI must be on your `PATH` (`npm install -g portbook`, or from the
> repo root: `npm link`). Verify with `portbook where`.

## Agent Panel (MCP)

Add portbook as a context server in your Zed `settings.json` (`zed: open settings`):

```jsonc
{
  "context_servers": {
    "portbook": {
      "source": "custom",          // required — Zed silently skips entries without it
      "command": "portbook",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

On **Windows**, if Zed fails to spawn the `portbook` shim, point at node + the script directly:

```jsonc
{
  "context_servers": {
    "portbook": {
      "source": "custom",
      "command": "node",
      "args": ["C:\\path\\to\\portbook\\bin\\portbook.js", "mcp"],
      "env": {}
    }
  }
}
```

Verify: Agent Panel → settings — the dot next to **portbook** should be green ("Server is active").
The agent then has all seventeen tools (`reserve`, `release`, `renew`, `list`, `check`, `scan`,
`ecosystem`, `gc`, `log`, the `*_block` territory tools, and the `request_port`/`inbox`/
`my_requests`/`grant_request`/`deny_request` negotiation tools — see [integrations/mcp/](../mcp/)). Pair it with the agent
etiquette in [AGENTS.md](../../AGENTS.md) (drop it into your Zed rules) so the agent *reserves before
it binds* and *asks instead of killing* what's on a port.

## Install

Pick one — Zed merges both, project tasks taking precedence:

- **Per-project** — copy `tasks.json` into the project's `.zed/tasks.json` (create the `.zed/` dir at
  the project root if needed). Tasks are then scoped to that project.
- **Global** — copy `tasks.json` into your user tasks file so the tasks are available everywhere:
  - macOS / Linux: `~/.config/zed/tasks.json`
  - Windows: `%APPDATA%\Zed\tasks.json`

If you already have a `tasks.json`, merge these entries into the existing JSON array rather than
overwriting it (the file is a single top-level array of task objects).

## Run

Open the task picker and pick one:

- `cmd-shift-p` (macOS) / `ctrl-shift-p` (Linux/Windows) → **task: spawn**
- or bind `task::Spawn` to a key, or rerun the last task with **task: rerun** (`task::Rerun`).

### Tasks

| Task | Runs | What it does |
| --- | --- | --- |
| `portbook: list` | `portbook list` | Reserved ports + live BOUND state. |
| `portbook: scan` | `portbook scan` | Everything actually listening on this machine; flags unmanaged ports. |
| `portbook: env` | `portbook env` | Full ecosystem: host ports + containers + WSL. |
| `portbook: serve` | `portbook serve --open` | Starts the dashboard (default http://127.0.0.1:7800) and opens it in your browser. Opens a new terminal and keeps running until you stop it (`ctrl-c`). |
| `portbook: reserve for this project` | `portbook reserve --project "$ZED_WORKTREE_NAME" --count 1 --owner zed` | Reserves one free port for the current project, named after the worktree, owned by `zed`. Prints the granted port. |

The reserve task uses Zed's [`$ZED_WORKTREE_NAME`](https://zed.dev/docs/tasks#variables) task
variable so the reservation is automatically named after whatever project you have open — no editing
required. Other variables Zed exposes (e.g. `$ZED_FILE`, `$ZED_COLUMN`) can be wired into custom
tasks the same way.

## Roadmap

MCP (above) covers the agent side natively. A future, richer *visual* integration would be a proper
**Zed extension** — packaging the context server for one-click install from Zed's extension registry,
and/or polling `GET /api/ecosystem` (from `portbook serve`) to render live port state inline. See the
repo README and `docs/FLEET.md` for the server/API surface.
