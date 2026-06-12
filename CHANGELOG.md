# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-06-11

Port **negotiation** — when a port you want is held, you ask through the ledger instead of
clobbering — plus a core-wide hardening pass closing all **31 confirmed findings** from a full
adversarial review. Still **zero runtime dependencies** (Node built-ins only, ESM, Node >= 18).

### Added
- **Port requests** (`requestPort`/`inbox`/`outbox`/`resolveRequest` in `src/registry.js`; a new
  `requests[]` array in the registry) — the negotiation layer between agents: ask the holder of a
  port instead of killing its process. CLI: `portbook request --port <p> --from <project>
  [--owner <o>] [--reason "..."]` files the ask, `portbook inbox [--project <p>]` shows the asks
  awaiting *your* answer, `portbook requests --from <project>` is the requester's outbox (verdicts +
  notes), and `portbook grant <id>` / `portbook deny <id>` (each takes `--note "..."`) answer one. A **grant on a
  reservation** releases the holder's claim in the same locked write and leaves the port **promised**
  to the requester — auto-picks skip it and even the ex-holder is refused — until their `reserve`
  consumes the grant; a **grant on a block** leaves the territory intact and issues a one-shot,
  port-specific exemption through that block. Requests are conversation, not state: resolved rows
  age out after ~24 h, unanswered ones after ~7 d, at most 32 pending per requester, and re-filing
  an identical pending ask is idempotent.
- **Negotiation on every surface**: HTTP (`GET /api/requests` with `?project=`/`?from=`/`?machine=`,
  `POST /api/requests`, `POST /api/requests/resolve`), five MCP tools (`request_port`, `inbox`,
  `my_requests`, `grant_request`, `deny_request`), and the fleet client — requests are
  machine-scoped like everything else, so a cubicle/fleet client negotiates over the shared ledger.
- **docs/CUBICLES.md** — the cubicle pattern: running many agents on one machine behind worktree /
  container / VM walls, with the host port space those walls *concentrate* coordinated through one
  shared `portbook serve`, territory blocks per agent, and request/grant instead of process-killing.

### Hardened
All 31 confirmed findings from the adversarial review of the core, across five fronts:
- **Lock integrity** — stale-lock takeover is atomic (tombstone-rename; exactly one breaker wins),
  release is owner-token-checked (a holder can never remove someone else's lock), and holders
  heartbeat during slow work so a live-but-slow holder is never judged stale and stolen from.
- **Ledger durability** — a corrupt registry is **quarantined** (`registry.json.corrupt-<ts>`) and
  the operation aborts loudly instead of silently wiping everyone's reservations; only ENOENT reads
  as a fresh registry; writes fsync before the atomic rename.
- **Machine-scoped truth** — `scan`/`check`/`ecosystem` cross-reference only the local machine's
  rows (a remote fleet hold can't masquerade as a local listener or a releasable ghost); legacy
  machine-less rows collide correctly; `release`/`releaseBlock` selectors AND together instead of
  widening; block claims are race-idempotent.
- **Server security** — CSRF/origin gate on POSTs (cross-origin browser writes are 403),
  constant-time token comparison, a bounded + TTL'd fleet-reports map, and oversized request bodies
  settle with `413` instead of hanging the handler.
- **CLI & parsers** — strict `--ttl`/`--pid`/`--port`/`--count`/`--range` validation (garbage exits 1
  instead of silently becoming a permanent hold), locale-tolerant `netstat`/`lsof`/WSL parsing,
  OS-excluded/privileged ports distinguished from in-use, and fleet multi-port reserve rolls back
  partial commits on failure.

[0.5.0]: https://github.com/theekruger/portbook/releases/tag/v0.5.0

## [0.4.0] - 2026-06-08

Port **territory** — projects can now claim a whole range, not just one port at a time — plus
sharper ergonomics for ports that already exist outside the registry. Still **zero runtime
dependencies** (Node built-ins only, ESM, Node >= 18).

### Added
- **Port-territory blocks** (`reserveBlock`/`releaseBlock`/`listBlocks` in `src/registry.js`) — a
  project claims a contiguous range it owns: `portbook block --project <p> --range <a-b>`. Reserving a
  specific port inside *another* project's block is rejected, and a block that overlaps another
  project's block (or would swallow its existing single-port reservation) is rejected too. Conflicts
  are **per machine**, mirroring reservations. Blocks are **persistent** — they carry no PID or TTL, so
  `gc`/reconciliation never reclaim them; `portbook release --project <p> --blocks` (or `--block <id>`)
  removes one. Surfaced in the fleet server (`GET`/`POST /api/blocks`, `POST /api/blocks/release`) and
  in `GET /api/fleet`.
- **Block-aware auto-pick** — `reserve --count N` (with no explicit `--range`) now draws ports from
  *within* the requesting project's own block(s), and every *other* project's auto-pick is steered
  around them, so adjacent projects stop drifting into each other's range.
- **`adopt` for external ports** — register a port you're **already** running on (a DB, a hand-started
  server) without the usual OS-free check: `portbook adopt <port> --project <name>` (also spelled
  `portbook reserve --port <p> --adopt`). The hold is recorded as `active`. Pairs with `portbook scan`,
  which tags every listener `managed` or **UNMANAGED** so you can find what to adopt.

### Documentation
- **Clarified that reservations are permanent by default** — a plain `reserve` lives until you
  `release` it and is never auto-reclaimed; `--pid` and `--ttl` are what make a hold *ephemeral*
  (auto-freed on process death / expiry). Documented across the README, `AGENTS.md`, and `docs/FLEET.md`
  alongside the new territory model.

[0.4.0]: https://github.com/theekruger/portbook/releases/tag/v0.4.0

## [0.3.0] - 2026-06-08

The first public release. portbook grew from a single-machine reservation file into a full
ecosystem view, editor/agent integrations, and cooperative multi-machine coordination — all with
**zero runtime dependencies** (Node built-ins only, ESM, Node >= 18).

### Added
- **OS-reconciled registry core** (`src/registry.js`) — a lock-guarded JSON registry at
  `~/.portbook/registry.json` (override with `PORTBOOK_DIR`). An atomic `mkdir` lock serializes
  reserve/release/gc across processes; writes are atomic (temp + rename); stale locks self-reclaim.
  `reserve` verifies a port is genuinely free at the OS level before granting; `gc` (and every
  `reserve`) reclaims holds whose PID is dead or whose TTL has expired. Each entry records
  who/why/PID/TTL plus the owning `machine`.
- **Ecosystem view** (`src/environments.js`) — `portbook env` cross-references host listeners with the
  containers running under Docker / Rancher / nerdctl / Podman (each host port labeled with the
  container that owns it) and detects WSL distros. Best-effort and guarded — a missing runtime just
  yields an empty list.
- **Zero-dependency web dashboard** (`src/server.js` + `public/index.html`) — `portbook serve` puts the
  live picture in the browser using Node's built-in `http` and one self-contained vanilla-JS page (no
  framework, no build step, no external assets).
- **MCP server** (`src/mcp.js`) — `portbook mcp` speaks JSON-RPC over stdio and exposes
  `reserve`/`release`/`list`/`check`/`scan`/`ecosystem`/`gc` as tools for AI agent harnesses.
- **Editor & harness integrations** — MCP config for Claude Code / Codex / Cursor / Windsurf / Hermes,
  a buildless VS Code extension (status bar + live Ports view), Zed task recipes, and JetBrains
  External Tools entries (see `integrations/`).
- **Fleet mode** (`src/client.js`) — set `PORTBOOK_SERVER=http://<host>:7800` and a machine's
  `reserve`/`release`/`list`/`check`/`gc` coordinate against a shared `portbook serve` authority
  instead of its local file. Conflicts are **per-machine** (two machines can both use `5000`).
  `portbook report` pushes a machine's ecosystem up; `portbook fleet` shows who's on what, everywhere.
  Unset the env var and it's fully local again. `PORTBOOK_MACHINE` overrides the reported machine name.
- **Optional token auth** — set `PORTBOOK_TOKEN` when running `portbook serve` and the data API
  (`/api/*`) is gated behind `Authorization: Bearer <token>` (401 without it). Clients send it
  automatically from their environment; the browser dashboard prompts for it once.
- **CLI** (`bin/portbook.js`) — `reserve`/`release`/`list`/`scan`/`env`/`serve`/`mcp`/`check`/`gc`/
  `fleet`/`report`/`import`/`where`, with `--json` on the read commands for scripting. `import` migrates
  a machine's local reservations into the fleet server (skipping any already present).

[0.3.0]: https://github.com/theekruger/portbook/releases/tag/v0.3.0
