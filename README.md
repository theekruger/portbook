# portbook

A tiny, **machine-wide port reservation registry** so multiple dev servers — and multiple AI coding agents working in parallel — stop colliding on the same ports.

> Built after an agent shuffled ports and silently killed another project's running servers. portbook is the shared source of truth that prevents that.

## Why
When several projects and several agents run servers on one machine, they grab ports ad-hoc and clobber each other. portbook makes every project/agent **reserve a port before binding** and **release it on exit**, against one shared registry. It also reconciles against the real OS state, so it reflects reality — not just bookkeeping.

## Install
```bash
git clone <repo> portbook && cd portbook
npm link        # puts `portbook` on your PATH (no dependencies; Node >= 18)
```

## Use
```bash
portbook reserve --project webapp --port 4100 --purpose "api origin" --owner claude
portbook reserve --project api --count 1 --range 4200-4299   # auto-pick a free one
portbook check 4100
portbook list                                # reserved ports + live BOUND state (yes/no/stale)
portbook scan --range 4000-9000              # what's ACTUALLY listening; flags unmanaged ports
portbook env                                 # full ecosystem: host ports + containers + WSL
portbook serve --open                        # live web dashboard at http://localhost:7800
portbook release --project api
portbook gc                                  # reclaim dead-PID / expired holds
portbook where                               # registry file path
```
`reserve` prints the granted port(s) to stdout, so scripts can capture them:
```bash
PORT=$(portbook reserve --project foo --count 1)
```
Add `--json` to `reserve` and `list` for machine-readable output (`check` is always JSON), so agents
and scripts can introspect without scraping columns:
```bash
portbook list --json | jq '.[] | select(.bound==false)'   # reserved but not actually running
```

`list` reflects reality, not just bookkeeping: **BOUND** reads the OS's own listener table, so a
service bound only to a specific interface (e.g. a Tailscale IP) still shows `yes`. `scan` goes
further and shows *everything* listening on the machine — including ports **not** in portbook — so
you can see your whole port picture at a glance and spot collisions before they happen.

### Ecosystem view & dashboard
`portbook env` widens the lens to your whole machine: host listeners **plus** the containers running
under Docker / Rancher / nerdctl — each host port labeled with the container that owns it (e.g.
`6379 → alkahest-redis`) — plus detected WSL distros. `portbook serve` puts the same picture in a
**zero-dependency live web dashboard** (Node's built-in `http` + one static HTML page — no framework,
no build step). It's also the server the [fleet design](docs/FLEET.md) builds on: bind it to a
Tailscale IP (`--bind`) and the very same process becomes the shared registry for every machine.

> Sub-environments come in two kinds. **Containers** are discoverable from the host (we read each
> one's published port map). **VMs / other machines / inside-WSL** are not — the model for those is a
> tiny portbook reporter running *inside* each, reporting up to `portbook serve`. See
> [docs/FLEET.md](docs/FLEET.md).

## How it works
- **Storage:** one JSON at `~/.portbook/registry.json` (override with `PORTBOOK_DIR`). Each entry records who/why/PID/TTL plus the `machine` (hostname) that holds it.
- **Concurrency-safe:** an atomic `mkdir` lock serializes reserve/release across processes; writes are atomic (temp + rename); a stale lock (>15s) is reclaimed automatically.
- **OS-reconciled:** `reserve` verifies a port is genuinely free at the OS level before granting; `list`/`scan` read the live listener table to show what's truly bound; `gc` (and every `reserve`) reclaims reservations whose PID is dead or whose TTL expired. `list`/`scan` never mutate — only `reserve`/`release`/`gc` do.

## For AI agents
See **[AGENTS.md](./AGENTS.md)** — the one rule that makes this work: *never hardcode a port; reserve first, release on stop.* Drop that section into your project's `CLAUDE.md` / `AGENTS.md`.

## Integrations
Drive portbook from the tools you already use — all thin clients over the same zero-dependency core.
Full guide: **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

- **AI agent harnesses** (Claude Code, Codex, Cursor, Windsurf, Hermes) — the **MCP server**: `portbook mcp`
  speaks JSON-RPC over stdio and exposes `reserve`/`release`/`list`/`check`/`scan`/`ecosystem`/`gc` as tools.
  Config + per-client setup in [integrations/mcp/](integrations/mcp/) (e.g. `claude mcp add portbook -- portbook mcp`).
- **VS Code / Cursor / Windsurf** — a thin, buildless extension (status bar + live Ports view): [integrations/vscode/](integrations/vscode/).
- **Zed** — task recipes that call the CLI: [integrations/zed/](integrations/zed/).
- **JetBrains** (IntelliJ/PyCharm/WebStorm/…) — External Tools entries: [integrations/jetbrains/](integrations/jetbrains/).
- **Anything else** — the HTTP API (`portbook serve`) + the `--json` CLI.

## Programmatic use
```js
import { reserve, release, check, list, annotate, scan } from "portbook";
import { ecosystem } from "portbook/environments";
const [{ port }] = await reserve({ project: "myapp", count: 1, owner: "agent", pid: process.pid });
const live = await annotate(list());      // reserved ports + { bound, stale } from live OS state
const { unmanaged, ghosts } = await scan(); // listening-but-unreserved / reserved-but-not-listening
const eco = await ecosystem();              // host + containers + WSL, all cross-referenced
```

## Fleet mode (multiple machines)
Set `PORTBOOK_SERVER=http://<host>:7800` and a machine's `reserve`/`release`/`list`/`check`/`gc`
coordinate against that shared `portbook serve` authority instead of its local file — so every machine
shares one registry. Conflicts are **per-machine** (two machines can both use `5000`). `portbook report`
pushes a machine's ecosystem up; `portbook fleet` shows who's on what, everywhere. Unset the env var and
it's fully local again. Run the server bound to a Tailscale IP and only your tailnet can reach it.
Details + the "reporter inside a VM" model: **[docs/FLEET.md](docs/FLEET.md)**.

## Roadmap
- **OSS core (this) — free, forever:** the CLI + library + dashboard + MCP/editor integrations + the
  self-hostable fleet shared-registry core. Complete, not crippleware.
- **Optional managed hosting (later):** for people who'd rather not self-host the fleet server —
  zero-setup sync, encrypted backups, and an end-to-end-encrypted tier. Open-core done honestly: any
  paid layer is for *operations*, never features; self-hosting stays free and complete.
