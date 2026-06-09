# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
