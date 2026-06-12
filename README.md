# portbook

[![CI](https://github.com/theekruger/portbook/actions/workflows/test.yml/badge.svg)](https://github.com/theekruger/portbook/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

A tiny, **machine-wide port reservation registry** so multiple dev servers — and multiple AI coding agents working in parallel — stop colliding on the same ports.

> Built after an agent shuffled ports and silently killed another project's running servers. portbook is the shared source of truth that prevents that.

## Why
When several projects and several agents run servers on one machine, they grab ports ad-hoc and clobber each other. portbook makes every project/agent **reserve a port before binding** and **release it on exit**, against one shared registry. It also reconciles against the real OS state, so it reflects reality — not just bookkeeping.

## Install
```bash
npm install -g portbook        # zero dependencies; Node >= 18
```
Or from source:
```bash
git clone https://github.com/theekruger/portbook && cd portbook
npm link        # same thing, your checkout on PATH
```

## Use
```bash
portbook reserve --project webapp --port 4100 --purpose "api origin" --owner claude
portbook reserve --project api --count 1 --range 4200-4299   # auto-pick a free one
portbook block --project api --range 4200-4299               # claim a range as your territory
portbook adopt 5432 --project db --purpose "postgres"        # register a port you already run on
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

> **Reservations are permanent by default.** A plain `reserve` lives until you `release` it — it is
> *never* auto-reclaimed. What makes a hold *ephemeral* (auto-freed by `gc` / the next `reserve`) is
> attaching a lifetime: `--pid <serverPid>` frees it when that process dies, and `--ttl <seconds>`
> frees it when the clock runs out. A reservation with **neither** a PID nor a TTL is permanent — use
> that for a project's long-lived origins, and a PID/TTL for throwaway or agent-spawned servers so a
> crash can't leak the port.

## Port territory (blocks)
Reserving one port at a time works, but for a project with several long-lived services it's cleaner
to claim a whole **range as territory** up front, then let portbook hand out ports inside it:

```bash
portbook block --project api --range 4200-4299    # claim 4200–4299 for "api"
portbook reserve --project api --count 1          # auto-picks INSIDE 4200–4299 (its own block)
portbook reserve --project web --count 1          # some OTHER project auto-picks AROUND that block
```

A block does two things, both per-project and **per machine**:

- **It's fenced off from everyone else.** Trying to grab a specific port inside another project's
  block fails loudly: `portbook reserve --project web --port 4250` → rejected because `4250` is inside
  `"api"`'s reserved block. Claiming a range that **overlaps** another project's block — or that would
  swallow another project's existing single-port reservation — is rejected the same way.
- **It steers your own auto-picks home.** When a project owns a block, its own `reserve --count N`
  (with no explicit `--range`) draws ports **from within that block** instead of the default
  `4000–4999`. Any *other* project's auto-pick skips over your block entirely. So two projects with
  adjacent blocks never drift into each other's range.

Blocks are **persistent** — they have no PID or TTL, so `gc` and reconciliation never reclaim them;
release one explicitly with `portbook release --project api --blocks` (or `--block <id>`). List them
with `portbook blocks` (add `--json` for scripts; `portbook block --project api` for one project's) —
`portbook list --json` stays a plain array of reservations, so claiming territory never changes the
shape your scripts parse. Your own project's block
never blocks *you* — overlapping or reserving inside your own territory is always fine; that's the
whole point of claiming it.

### Negotiation (requests)
When a port you want is already **held** — reserved by another project, or inside its block — don't
kill the process or steal the claim: **ask through the ledger**.

```bash
portbook request --port 5173 --from webapp --reason "vite default"   # file the ask
portbook inbox --project api                 # the HOLDER: pending asks against your ports
portbook grant <id> --note "all yours"       # …or: portbook deny <id> --note "still using it"
portbook requests --from webapp              # the REQUESTER: poll your filings for the verdict
```

A **grant** releases the holder's reservation in the same locked write and holds the port for the
requester until they `reserve` it; if the port was only block-territory, the grant is a one-shot
exemption through that block instead (the territory survives). A **deny** leaves the verdict + note
in the requester's outbox. Resolved requests age out after ~a day, unanswered ones after ~a week.
The same verbs exist as MCP tools and HTTP routes ([docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)) —
and they're the conflict-resolution half of the **cubicle pattern** for running many agents on one
machine: **[docs/CUBICLES.md](docs/CUBICLES.md)**.

### Adopting an existing port
Sometimes a port is already in use by something portbook didn't reserve — a database, a system
daemon, a server you started by hand. Two commands handle that:

- **`portbook scan`** is how you *find* them: it lists every listener on the machine and tags each one
  `managed` (in portbook) or **UNMANAGED** (listening but unreserved) so you can triage what's running
  outside the registry.
- **`portbook adopt <port> --project <name> [--purpose "..."]`** is how you *claim* one: it registers
  a port you're **already** running on, skipping the normal "is this port free?" check (a plain
  `reserve --port` on an occupied port fails on purpose). The hold is recorded as `active` and, like
  any reservation, is permanent until you `release` it. (`portbook reserve --port <p> --adopt` is the
  same operation spelled as a flag.)

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
- **Concurrency-safe:** an atomic `mkdir` lock serializes reserve/release across processes. The holder stamps the lock with an owner token and heartbeats it while it works, so releases only ever remove the holder's own lock — and a crashed holder's lock (no heartbeat for >15s) is taken over atomically by exactly one waiter. Writes are atomic (temp + rename).
- **OS-reconciled:** `reserve` verifies a port is genuinely free at the OS level before granting; `list`/`scan` read the live listener table to show what's truly bound; `gc` (and every `reserve`) reclaims reservations whose PID is dead or whose TTL expired. `list`/`scan` never mutate — only `reserve`/`release`/`gc` do.

## For AI agents
See **[AGENTS.md](./AGENTS.md)** — the one rule that makes this work: *never hardcode a port; reserve first, release on stop.* Drop that section into your project's `CLAUDE.md` / `AGENTS.md`.
Running a whole fleet of agents in parallel on one machine (worktrees / containers / VMs)? The
cubicle pattern — isolation walls plus a shared port ledger — is in **[docs/CUBICLES.md](docs/CUBICLES.md)**.

## Integrations
Drive portbook from the tools you already use — all thin clients over the same zero-dependency core.
Full guide: **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

- **AI agent harnesses** (Claude Code, Codex, Cursor, Windsurf, Hermes) — the **MCP server**: `portbook mcp`
  speaks JSON-RPC over stdio and exposes `reserve`/`release`/`list`/`check`/`scan`/`ecosystem`/`gc` —
  plus the block-territory tools `reserve_block`/`list_blocks`/`release_block` and the negotiation
  tools `request_port`/`inbox`/`my_requests`/`grant_request`/`deny_request` — as tools.
  Config + per-client setup in [integrations/mcp/](integrations/mcp/) (e.g. `claude mcp add portbook -- portbook mcp`).
- **VS Code / Cursor / Windsurf** — a thin, buildless extension (status bar + live Ports view), on the
  Marketplace as [`portbook.portbook`](https://marketplace.visualstudio.com/items?itemName=portbook.portbook): [integrations/vscode/](integrations/vscode/).
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
Set `PORTBOOK_SERVER=http://<host>:7800` and every ledger command — `reserve`/`release`/`list`/`check`/`gc`,
`block`/`blocks`, and the `request`/`inbox`/`requests`/`grant`/`deny` flow — coordinates against
that shared `portbook serve` authority instead of the local file — so every machine
shares one registry. Conflicts are **per-machine** (two machines can both use `5000`). `portbook report`
pushes a machine's ecosystem up; `portbook fleet` shows who's on what, everywhere; `portbook import`
migrates a machine's existing local reservations into the shared server (skipping any already present),
so you can adopt fleet mode without re-reserving by hand. Unset the env var and it's fully local again.
Run the server bound to a Tailscale IP and only your tailnet can reach it.
Details + the "reporter inside a VM" model: **[docs/FLEET.md](docs/FLEET.md)**.

## Limitations
Worth knowing before you lean on it:

- **It's a cooperative convention, not enforcement.** portbook coordinates well-behaved servers and
  agents; it does **not** stop a process from binding a free port it never reserved — the OS still
  hands any port to anyone who asks. The value comes entirely from *everyone* on a machine actually
  reserving first. One tool that hardcodes `3000` can still clobber a reservation. Treat `list`/`scan`
  as the shared map, not a lock.
- **OS & container detection is best-effort.** Liveness and ecosystem views shell out to the tools you
  already have (`ss`/`lsof`/PowerShell/`netstat` for listeners; `docker`/`nerdctl`/`podman` and `wsl`
  for sub-environments). Output formats vary by version and platform, and a tool that's absent, slow,
  or behind a permission prompt simply reports nothing — these enumerations are guarded so they never
  throw, but that means they can also under-report. The **registry** is always authoritative; the live
  BOUND/scan columns are a best-effort overlay on top of it.
- **Fleet mode is cooperative-trust.** The shared server believes the `machine` name and OS-free check
  each client sends — it cannot verify another machine's identity or actually see inside its OS. So run
  `portbook serve` on a **private** network only (e.g. a Tailscale IP via `--bind`), set
  `PORTBOOK_TOKEN` for defense in depth, and never expose it to the public internet. It's the trust
  model of any internal dev service, not an authenticated multi-tenant API.
- **It's a young project.** The core is exercised by a test suite in CI across Linux, macOS, and
  Windows, but it hasn't been battle-tested across a wide range of real-world setups yet. Edge cases in
  shell output, container runtimes, and odd network stacks are exactly where bugs will hide — if you
  hit one, please [open an issue](https://github.com/theekruger/portbook/issues).

## Roadmap
- **OSS core (this) — free, forever:** the CLI + library + dashboard + MCP/editor integrations + the
  self-hostable fleet shared-registry core. Complete, not crippleware.
- **Optional managed hosting (later):** for people who'd rather not self-host the fleet server —
  zero-setup sync, encrypted backups, and an end-to-end-encrypted tier. Open-core done honestly: any
  paid layer is for *operations*, never features; self-hosting stays free and complete.

## Support
If portbook saves you from a port collision or two, you can support its development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/theekruger)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/theekruger)

It stays **zero-dependency, cross-platform, and free** either way — sponsorships just help keep it
maintained. Thank you! ☕
