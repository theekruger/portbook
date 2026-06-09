# Contributing to portbook

Thanks for helping out. portbook is small on purpose — these notes keep it that way.

## The one hard rule: zero runtime dependencies

The CLI and library use **Node built-ins only** (`node:fs`, `node:child_process`, `node:http`, …).
No npm runtime dependencies, ever — not in `src/`, not in `bin/`. This is the project's headline
promise (`npm i -g portbook` pulls nothing else) and the reason it starts instantly and runs
anywhere with Node >= 18. If you reach for a package, find the built-in equivalent or keep the helper
local. Dev-only tooling is fine to discuss in a PR, but the shipped code stays dependency-free.

ESM throughout (`"type": "module"`); use `import`, not `require`.

## Getting started

```bash
git clone https://github.com/theekruger/portbook && cd portbook
npm link        # puts `portbook` on your PATH for manual testing
npm test        # run the whole suite (no build step)
```

There's nothing to compile — run the source directly.

## Tests

`npm test` runs every suite in sequence; each one points at a throwaway `PORTBOOK_DIR` so it never
touches your real registry:

- `test/smoke.js` — registry core: reserve / release / list / check / gc / scan, locking, OS reconcile.
- `test/environments.js` — environment providers: port parsing + the cross-referenced ecosystem view.
- `test/parsers.js` — the OS listener-table parsers (ss / lsof / netstat / PowerShell), fed captured
  sample output so every platform's parsing path runs on any host.
- `test/mcp.js` — the MCP server's JSON-RPC tool surface.
- `test/fleet.js` — fleet mode: client ↔ shared-server round-trips, per-machine conflicts, report/fleet.
- `test/import.js` — `portbook import`: migrate local reservations into a shared server (subprocess
  server with its own `PORTBOOK_DIR`), asserting the migration and an idempotent re-run.
- `test/auth.js` — `PORTBOOK_TOKEN` bearer auth on the HTTP API.

Add or extend a suite for any behavior you change, and after touching the core or CLI also eyeball
`portbook list` and `portbook scan` by hand.

## Module layout

```
src/registry.js      core: lock-guarded JSON registry + OS reconciliation. ALL reservation logic.
src/environments.js  environment providers (containers + WSL) and ecosystem(). Imports registry.js
                     one direction only — never make registry.js import this (avoids a cycle).
src/server.js        zero-dep http server: JSON API + serves public/index.html. Basis for fleet mode.
src/client.js        the fleet client used when $PORTBOOK_SERVER is set (sends $PORTBOOK_TOKEN).
src/mcp.js           the MCP server (JSON-RPC over stdio).
bin/portbook.js      the CLI — arg parsing + output formatting only; delegates to the core/providers.
public/index.html    the dashboard — one self-contained vanilla-JS page (no framework, no build).
```

Keep the layers honest: `reserve`/`release`/`gc` mutate (under `withLock`); `list`/`check`/`scan`/
`annotate` are read-only — don't make a read command write. And keep the two truth checks distinct:
`isPortFree` answers "can I bind here *now*?" (used by `reserve`), while `getListeners` answers "is
something *actually* listening?" (used by liveness reporting) — don't conflate them.

## Adding an environment provider

Sub-environment detection lives in `src/environments.js`. To support another container runtime or
VM source: write a small `async` function that shells out with `execFile`, parses the output into the
same normalized shape the existing providers return, and fold it into `ecosystem()`. Two requirements:

- **Best-effort and guarded.** Wrap the shell-out so a missing/old/unresponsive tool yields an empty
  list instead of throwing — enumeration failures must never propagate outward.
- **Cross-platform.** Listener enumeration already branches (PowerShell/`netstat` on Windows,
  `ss`/`lsof` on POSIX); match that pattern and guard each path.

## Adding an integration

Integrations under `integrations/` are **thin clients over the same core** — the MCP server, the
`--json` CLI, or the HTTP API. They don't reimplement reservation logic. Mirror an existing one
(`integrations/vscode/` is buildless; `integrations/zed/` and `integrations/jetbrains/` just call the
CLI) and keep it dependency-light to match the rest of the project.

## Code style

Terse and well-commented. Match the surrounding code: compact functions, a short comment explaining
*why* (or the tricky edge case) rather than restating the *what*. Prefer clarity over cleverness, and
keep new surface area small — a smaller portbook is a better portbook.

When in doubt, open an issue before a large change so we can agree on shape first.
