# Cubicles — running many agents on one machine without collisions

You hand five AI agents five tasks and let them run. Twenty minutes later two have edited the same
file, one has `npm install`ed over another's half-finished build, and a third has killed the dev
server a fourth was mid-test against — because it wanted port 5173. The fix is the one open-plan
offices found: **cubicles**. Give every agent its own walled workspace, then coordinate the one
resource the walls can't split — the host's port space — through a shared ledger: portbook.

## The problem

Parallel agents on one checkout share *everything*: the working tree (edits and build artifacts
clobber each other), the process table (an agent "cleaning up" kills a sibling's server), and the
port space (two dev servers want 3000; the second either fails or "resolves" the conflict by killing
the first). Walls fix the first two. The third they make *worse* — see below.

## The isolation ladder

Each rung walls off more; climb only as high as your setup needs:

| Rung | Walls off | Still shared |
|------|-----------|--------------|
| **git worktrees** (`git worktree add`) | the working tree — each agent edits its own checkout on its own branch | everything else: one OS, one process table, **one port space**, shared daemons/DBs |
| **containers / devcontainers** | files, processes, and the container's own network namespace — inner ports are private | published ports (`-p host:container`) land on the host; the image cache, volumes, and daemon |
| **WSL2 / lightweight VMs** | a whole kernel: filesystem, process table, network stack | forwarded ports surface on the host (WSL2 even auto-forwards `localhost`); CPU/RAM/disk |

## What the walls concentrate: the host port space

Read the right-hand column again — every rung still **funnels ports onto the host**. A worktree
agent binds host ports directly. A container's published ports *are* host ports. A WSL2 distro's
servers appear on the host's `localhost`. So isolation doesn't remove the port problem, it
concentrates it: N walled workspaces all dumping servers into one shared namespace, each unable to
see the others'. That shared surface is exactly portbook's lane — one ledger every cubicle reads
and writes, reconciled against the real OS.

## The recipe

**1. The host runs the ledger.** One `portbook serve` on the host is the authority every cubicle
talks to (a cubicle's own local `~/.portbook` file would be a private fiction):

```bash
PORTBOOK_TOKEN=<secret> portbook serve --bind 0.0.0.0 --port 7800
```

Bind an interface every cubicle can reach — `0.0.0.0` on a private dev machine, with the token doing
the gating; tighten to the Docker bridge or a tailnet IP if you can. Never the public internet
(see [FLEET.md](./FLEET.md) for the trust model).

**2. Every cubicle gets three env vars** — bake them into the worktree's env file, the
devcontainer's `containerEnv`, or the VM's profile:

```bash
export PORTBOOK_SERVER=http://host.docker.internal:7800  # however this cubicle reaches the host
export PORTBOOK_TOKEN=<secret>
export PORTBOOK_MACHINE=cubicle-a                        # this cubicle's identity in the ledger
```

`PORTBOOK_MACHINE` names the port space a claim lives in — conflicts are **per machine**. For
container/VM cubicles that's literally true (each has its own network namespace), so their inner
ports are scoped to the cubicle and the dashboard shows each cubicle as its own machine. **Worktree
cubicles share the host's network namespace — leave `PORTBOOK_MACHINE` unset there** so they share
the host's name too; distinct names would keep same-numbered claims from ever meeting in the ledger
while they collide on the real OS.

**3. The orchestrator deals territory.** One block per agent/project on the host's port space, so
each agent's auto-picks land in its own lane and stray grabs fail loudly:

```bash
portbook block --project agent-a --range 4100-4199 --owner orchestrator --purpose "cubicle a"
portbook block --project agent-b --range 4200-4299 --owner orchestrator --purpose "cubicle b"
```

Territory is machine-scoped like every other claim, so these blocks govern claims filed under the
**host's** name: worktree cubicles (which share it) are steered and fenced directly. A container/VM
cubicle's own claims live under its cubicle name — but its *published* ports land in the host's
space, so the orchestrator draws them from the cubicle's block at launch:
`PORT=$(portbook reserve --project agent-b --count 1)` on the host auto-picks inside agent-b's
block; publish `-p $PORT:5173`.

**4. Every cubicle's agent loads the portbook MCP server** (`claude mcp add portbook -- portbook mcp`,
or the config block in [integrations/mcp/](../integrations/mcp/)) so reserving, releasing, checking —
and the negotiation below — are first-class tools rather than shell strings it might skip. Drop the
[AGENTS.md](../AGENTS.md) etiquette into each cubicle's instructions file. Scoping note: the MCP
server works the **local** registry file, not `PORTBOOK_SERVER`. For worktree cubicles that's the
same ledger the host's `serve` reads; a container/VM cubicle's agent must use the CLI — which *does*
honor fleet mode — for anything that touches the shared ledger.

## Negotiation instead of collision

The lifecycle: **request → the holder's inbox → grant or deny**. Two agents in one port space, one
port — `agent-b` needs 5173 (its e2e fixtures assume Vite's default), but `web-app` holds it:

```bash
# agent-b — discovers the hold, asks instead of clobbering:
$ portbook check 5173                       # → reserved by "web-app"
$ portbook request --port 5173 --from agent-b --reason "e2e fixtures assume 5173"
request mq9rx8q7z7n0y1 (pending): port 5173 asked of "web-app" — verdict shows in `portbook requests --from agent-b`

# web-app's agent — checks its inbox at the next natural pause:
$ portbook inbox --project web-app
ID               PORT   FROM             REASON                       AGE
mq9rx8q7z7n0y1   5173   agent-b          e2e fixtures assume 5173     3m
$ portbook grant mq9rx8q7z7n0y1 --note "moved to 5174"   # or: portbook deny <id> --note "mid-test"
granted request mq9rx8q7z7n0y1: port 5173 → "agent-b" — released "web-app"'s reservation; the port is held for them until they reserve it

# agent-b — polls its outbox, then claims:
$ portbook requests --from agent-b          # → granted (note: moved to 5174) — claim it:
$ portbook reserve --project agent-b --port 5173 --pid <serverPid> --purpose "vite dev"
```

What a verdict actually does:

- **Grant on a reservation** releases the holder's claim *in the same locked write* and leaves the
  port **promised** to the requester: until their `reserve` consumes it (or the grant ages out),
  everyone else is refused — auto-picks skip it, and even the ex-holder can't take it back.
- **Grant on a block** (the port sat inside someone's territory, not individually reserved) leaves
  the territory intact and issues a **one-shot, port-specific exemption** through that block.
- **Deny** records the verdict and your `--note` in the requester's outbox; the holder keeps the port.
- **The ledger moves; the process doesn't.** A grant releases the *claim* — the holder still stops
  whatever it was running there, and the grantee's `reserve` still probes the OS, so granting with
  the old server still listening fails loudly instead of double-binding.

Requests are conversation, not state: resolved rows evaporate after ~a day, unanswered ones after
~a week, and a requester can have at most 32 asks pending — inboxes never silt up. `portbook inbox`
with no `--project` shows *every* pending ask in that port space, so an orchestrator can arbitrate
centrally instead of leaving verdicts to individual agents. Over MCP the same verbs are tools —
`request_port`, `inbox`, `my_requests`, `grant_request`, `deny_request` — so a cubicled agent never
touches a shell for this.

## Honest limits

- **The walls are hard; the ledger is cooperative.** Containers and VMs genuinely prevent file and
  process interference — the kernel enforces that. The port ledger doesn't: the OS will still hand an
  unreserved port to any process that asks (see [Limitations](../README.md#limitations)). The value
  comes from every agent in every cubicle following the convention — which is exactly why each one
  gets the MCP server and the AGENTS.md rule, not a polite suggestion.
- **Negotiation is etiquette, not arbitration.** A grant moves the ledger claim; nothing forces the
  ex-holder's process to exit, and a buggy agent can still bind whatever it likes. portbook makes the
  polite path the easy path; it can't make the rude path impossible.
- **Cubicles don't merge code.** Isolation solves *collisions*, not *integration* — each agent's work
  still lands on a branch and meets the others where it always has: at git, through PRs and review.
