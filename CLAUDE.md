# portbook — notes for agents & developers

A machine-wide **port reservation registry** (CLI + library) so multiple dev servers and AI agents
stop colliding on ports. Zero runtime dependencies, ESM, Node ≥ 18.

## Layout
- `src/registry.js` — the core: lock-guarded JSON registry + OS reconciliation. All reservation logic lives here.
- `src/environments.js` — environment providers: container (`docker`/`nerdctl`/`podman`) + WSL enumeration, and `ecosystem()` which cross-references them with host listeners + the registry. Imports from `registry.js` (one direction — never make `registry.js` import this, to avoid a cycle).
- `src/server.js` — zero-dep `http` server: JSON API + serves `public/index.html`. Also the basis for fleet mode.
- `public/index.html` — the dashboard: one self-contained vanilla-JS page, no framework, no build, no external assets.
- `bin/portbook.js` — the CLI (arg parsing + output formatting only; delegates to the core/providers).
- `test/smoke.js` + `test/environments.js` — run against a throwaway `PORTBOOK_DIR`. **Run both with `npm test`.**
- `AGENTS.md` — the canonical port convention every agent on this machine should follow.
- `docs/FLEET.md` — design for cross-machine coordination (`portbook serve` exists locally; remote write/aggregation is the not-yet-built part).

## Conventions
- Keep it **dependency-free** and compact; match the existing terse, well-commented style.
- `reserve`/`release`/`gc` mutate under `withLock`; `list`/`check`/`scan`/`annotate` are read-only —
  preserve that split (don't make a read command write).
- `reserve` uses `isPortFree` (can I bind here *now*?); liveness reporting uses `getListeners` (is
  something *actually* listening?, which also sees interface-specific binds). Don't conflate them.
- Cross-platform: `getListeners` uses PowerShell/`netstat` on Windows, `ss`/`lsof` on POSIX, all
  best-effort and guarded — never let an enumeration failure throw.
- After any change to the core or CLI, run `npm test` and eyeball `portbook list` / `portbook scan`.

## Dogfood it
This project defines the port rule — so follow it here too: reserve before binding any dev port, and
`portbook release` on stop.
