# portbook fleet — coordinating ports across machines

> Status: **implemented** (the shared-registry core). Set `PORTBOOK_SERVER=http://<host>:7800` and a
> machine's `reserve`/`release`/`list`/`check`/`gc` coordinate against that shared `portbook serve`
> authority instead of its local file; `portbook report` pushes a machine's ecosystem up and
> `portbook fleet` shows every machine. Conflicts are per-machine (two machines can both use 5000).
> Optional bearer auth (`PORTBOOK_TOKEN`) and a fleet section in the dashboard ship today; still
> self-hosted by design — richer cross-machine views are future work.

## Using it today

```bash
# On one always-on node (bind to its tailnet IP so only your tailnet can reach it):
portbook serve --bind 100.x.y.z --port 7800

# On every machine (set once in your shell profile):
export PORTBOOK_SERVER=http://100.x.y.z:7800
export PORTBOOK_MACHINE=$(hostname)        # optional; defaults to the hostname

portbook reserve --project web --count 1   # reserves against the shared registry
portbook list                              # shows every machine's holds (MACHINE column)
portbook report                            # push this machine's containers/ports to the fleet view
portbook fleet                             # who's on what, everywhere
```

Unset `PORTBOOK_SERVER` and everything falls back to the local file — a laptop off the tailnet still
works fully offline. A reporter *inside* a VM/container can set `PORTBOOK_MACHINE` to a logical name
so its ports show up under that machine in the fleet view.

## The problem with "just sync the file"

The obvious idea is to put `~/.portbook/registry.json` on a synced drive (Dropbox, OneDrive, a
Tailscale drive) so every machine sees it. **Don't.** It quietly breaks all three guarantees the
local tool relies on:

1. **The lock doesn't lock.** Safety comes from an atomic `mkdir` on one filesystem. A synced folder
   replicates *after* the fact — two machines can `mkdir` "their" copy of the lock at the same time
   and both win. Concurrent reserves race and the last writer clobbers the other.
2. **Atomic rename isn't atomic across the sync.** `temp + rename` is atomic on one disk; the sync
   layer can propagate a half-written or conflicted copy (`registry (conflicted copy).json`).
3. **The truth checks are local.** `isPortFree` tests *this* OS and `pidAlive` tests *this* process
   table. A reservation synced from machine A tells machine B nothing about whether A's port is
   actually bound or A's PID is alive.

Net result: a registry that looks shared but coordinates nothing — a *false* sense of safety, which
is worse than no sharing at all.

## The model that works: one authority, thin clients

Run portbook as a small service on **one** node. Every machine's CLI/library becomes a thin client
that talks to it. There is exactly one registry and one writer, so concurrency is trivially correct.

```
                       ┌─────────────────────────────────────┐
   machine A  ─────▶   │  portbook serve   (the authority)    │
   machine B  ─────▶   │  · holds the single registry.json    │
   machine C  ─────▶   │  · serializes writes in-process      │
                       │  · reconciles by TTL + client report │
                       └─────────────────────────────────────┘
   each client reserves/releases over HTTP; OS-truth for a port
   is reported by the machine that owns it (only it can see it).
```

### Why Tailscale is the right transport for you

You already run Tailscale (the `8443`–`8446` serve entries). It gives every machine a stable private
IP on an encrypted mesh, so:

- The service binds to the host's **tailnet IP only** — never the public internet.
- No inbound firewall holes, no TLS to manage, no auth server. Tailscale ACLs already decide who can
  reach the port; an optional shared token (`PORTBOOK_TOKEN`) adds defense in depth.
- It works identically whether the machines are in one room or across the world.

## Concrete shape

**Server** — a new subcommand wrapping the existing core (the registry functions don't change; only
where they run and how they're reached):

There is **no `--token` flag** — auth is the `PORTBOOK_TOKEN` env var on the server process
(optional, but recommended once the server leaves `127.0.0.1`):

```bash
# on the chosen host (e.g. an always-on node), bound to its tailnet IP — bash:
PORTBOOK_TOKEN=<secret> portbook serve --bind 100.x.y.z --port 7800
```

```powershell
# same thing from PowerShell:
$env:PORTBOOK_TOKEN = "<secret>"; portbook serve --bind 100.x.y.z --port 7800
```

It exposes the current operations as JSON over HTTP — every data route lives under `/api/`
(`src/server.js` is the source of truth):

| Method & path              | Maps to          | Notes                                            |
|----------------------------|------------------|--------------------------------------------------|
| `GET  /`                   | the dashboard    | static HTML shell; stays public even with a token |
| `POST /api/reserve`        | `reserve()`      | body = reserve opts; a fleet client adds its `machine` and `probe:false` (it free-checks locally) → the reservation(s) made |
| `POST /api/release`        | `release()`      | `{ port \| project \| id, machine? }` → `{ released: <count> }` |
| `GET  /api/list`           | `list()`         | `?project=` to filter; `?raw=1` skips live annotation (fleet clients annotate locally). Returns every machine's rows — clients filter by `machine` themselves |
| `GET  /api/check/:port`    | `check()`        | `{ port, reservation, osFree }`                  |
| `POST /api/gc`             | `gc()`           | TTL-based → `{ reclaimed: <count> }`; PID liveness is per-machine, client-side |
| `GET  /api/scan`           | `scan()`         | the server host's **own** OS listeners (not fleet-wide) |
| `GET  /api/ecosystem`      | `ecosystem()`    | the server host's own host + containers + WSL view |
| `POST /api/report`         | —                | `{ machine, ecosystem }` → `{ ok, machines }`; how a machine pushes its view up |
| `GET  /api/fleet`          | —                | `{ server, at, reservations, blocks, reports }` — every machine's holds + latest reports |
| `GET  /api/blocks`         | `listBlocks()`   | `?project=` to filter; port-territory blocks for every machine |
| `POST /api/blocks`         | `reserveBlock()` | claim a range; body carries the client's `machine` → the block made |
| `POST /api/blocks/release` | `releaseBlock()` | `{ id \| project, machine? }` → `{ released: <count> }` |

*Future (not implemented):* a server-side `machine` filter on `/api/list`, and server-side merging of
client-posted scans. Today cross-machine visibility comes from `POST /api/report` + `GET /api/fleet`,
and clients filter `list` rows by `machine` themselves — exactly what the bundled fleet client does.

**Port-territory blocks are fleet-aware too.** A project's claimed range lives in the same shared
ledger as reservations and is **machine-scoped** (a `machine` field, mirroring reservations — the same
range on machine A and machine B don't collide). Clients read and write them over `GET`/`POST
/api/blocks` (and `POST /api/blocks/release`), and `GET /api/fleet` returns every machine's blocks
alongside its reservations. Because a block carries no PID or TTL it is **persistent** — the server
never reconciles or `gc`s it; it stays until a `release`.

**Client** — the CLI already shells through one set of functions; a single env var flips local↔remote:

```bash
export PORTBOOK_SERVER=http://100.x.y.z:7800   # set once per machine (shell profile)
portbook reserve --project api --count 1       # now reserves against the shared registry
portbook list                                  # shows every machine's reservations
```

When `PORTBOOK_SERVER` is unset, the CLI behaves exactly as it does today (local file). That keeps a
laptop that's off the tailnet fully functional offline.

### Who checks OS truth

The one subtlety: only the machine that owns a port can see whether it's bound or its PID is alive.
So:

- **Before reserving**, the client runs `isPortFree` locally and sends the result; the server trusts
  it for that machine.
- **`list`/`scan`** show `bound` only for the calling machine's own ports (others are reported by
  their owners via periodic heartbeat, or shown as `bound: null` = "not observed from here"). This is
  already how the `annotate()` function is written — it returns `bound: null` for non-local rows.
- **GC** uses TTL centrally; PID-based reclaim is delegated to each machine reporting its own dead
  holds. Recording `--pid` and `--ttl` therefore matters more in fleet mode than locally.

## Migration path (additive, no data loss)

1. **Today (done):** every reservation records `machine` (its hostname). Single-machine behavior is
   unchanged; the field is just carried along.
2. **`portbook serve` already exists** (it powers the local dashboard) — bound to `127.0.0.1` today.
   Fleet mode is two additive steps on top of it: bind it to a tailnet IP (`--bind 100.x.y.z`), and
   add an HTTP **client** shim behind the existing functions (gated on `PORTBOOK_SERVER`) so other
   machines write to it. No change to `registry.js`'s logic — it's the same core, hosted. Each
   machine still runs its own `ecosystem()` locally and reports it up, since only it can see inside
   its own containers/processes.
3. **Point machines at the server** by exporting `PORTBOOK_SERVER`. Existing local registries are
   imported once with `portbook import` on each machine — it pushes that machine's reservations *and*
   territory blocks into the shared ledger, skipping anything already present.
4. **Dashboard** — `portbook serve` already serves the live web view at `GET /`, and it grows a fleet
   section (fed by `GET /api/fleet`) once several machines share the registry: "who's on what,
   everywhere." This is the managed-hosting / control-plane surface in the README roadmap.

## Trust & operational notes

- **Optionally token-protected.** Set `PORTBOOK_TOKEN=<secret>` when you run `portbook serve` and the
  server gates the data API (`/api/*`) behind `Authorization: Bearer <secret>` (returning 401 without
  it). Clients send it automatically when the same `PORTBOOK_TOKEN` is in their environment, and the
  browser dashboard prompts for it once. Independently of the token, state-changing `POST`s that
  arrive with a cross-site browser `Origin` are rejected unless they carry the token — so a drive-by
  web page can't mutate the registry through your browser. Beyond that it's cooperative — the server trusts the
  `machine` name and OS check a client sends (it can't verify another machine's OS or identity) — so
  still bind it to a **private** interface (your Tailscale IP), never the public internet. Same trust
  model as any internal dev service.
- **Use `--ttl` (or `--pid`) on fleet reservations.** Only the owning machine can tell whether its PID
  is alive, so the server can't reclaim a *crashed* machine's dead-PID holds. A TTL lets the server
  expire them automatically; without one, a hard crash leaks the hold until that machine runs `gc`
  again. Long-lived project reservations are fine without a TTL; ephemeral/agent holds should set one.

## Non-goals (for now)

- Multi-writer consensus / HA of the service. One host is the authority; if it's down, machines fall
  back to local mode. Good enough until it isn't.
- Enforcing reservations at the network layer. portbook is cooperative — it coordinates well-behaved
  agents and servers; it does not *prevent* a process from binding a port it didn't reserve.
