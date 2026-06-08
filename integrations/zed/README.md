# portbook × Zed

Run portbook from inside [Zed](https://zed.dev) via its built-in **task** system + the `portbook`
CLI. Zed can't render a custom panel yet, so tasks + the CLI is the pragmatic path: each task just
shells out to a `portbook` subcommand and shows the output in an integrated terminal.

> Prereq: the `portbook` CLI must be on your `PATH` (from the repo root: `npm link`). Verify with
> `portbook where`.

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

These tasks are CLI-only and zero-dependency. A future, richer integration would be a proper **Zed
extension** that talks to the portbook HTTP API instead of shelling out — e.g. polling
`GET /api/ecosystem` (from `portbook serve`) to render live port state inline, and `POST /api/reserve`
/ `POST /api/release` for one-click reserve/release. See the repo README and `docs/FLEET.md` for the
server/API surface.
