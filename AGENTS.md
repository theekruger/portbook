# Port convention for agents (portbook)

If you (an AI agent or a script) start a server/process that binds a TCP port on this machine, you
MUST coordinate through **portbook** so you don't collide with other agents or projects. This is the
rule that prevents incidents like one agent silently killing another project's running servers.

## The rule
1. **Reserve before you bind.** The easiest way is the one-command wrapper — reserve, inject,
   release on exit, all handled (the port arrives as `$PORT`; `{port}` in the command substitutes):
   ```bash
   portbook run --project <project> --owner <agent> -- npm run dev
   ```
   Or reserve explicitly, then bind that exact port — never hardcode a port without reserving first:
   ```bash
   PORT=$(portbook reserve --project <project> --count 1 --owner <agent> --purpose "<what>")
   # ...start your server on $PORT...
   ```
   Or claim a specific port (fails loudly if it's taken):
   ```bash
   portbook reserve --project <project> --port 4100 --owner <agent> --purpose "<what>"
   ```
2. **A reservation is permanent by default** — it lives until you `release` it. Make it *ephemeral*
   so a crash can't leak the port: pass `--pid <serverPid>` (auto-freed when that process dies) or
   `--ttl <seconds>` (auto-freed when it expires; extend a hold you still need with
   `portbook renew --project <project> --ttl <seconds>`). Plain holds with neither are for a
   project's long-lived origins; agent-spawned/throwaway servers should always carry a PID or TTL
   (`portbook run` handles this for you).
3. **Claim your range as territory** if your project runs several long-lived servers: once with
   `portbook block --project <project> --range <a-b>`. After that, your `reserve --count N` auto-picks
   *inside* that range, everyone else is steered around it, and grabbing a port inside it fails loudly
   for other projects. Record your block under "Known reserved blocks" below. Adopt a port you already
   run on (a DB, an existing server) with `portbook adopt <port> --project <project>`.
4. **Release on stop.** `portbook release --project <project>` (or `--port <p>`).
5. **Before touching a port you didn't reserve,** run `portbook check <port>` and `portbook list`
   (the **BOUND** column shows what's actually listening right now). `portbook scan` shows *every*
   listening port on the machine — including ones nobody reserved (tagged **UNMANAGED**) — and
   `portbook env` widens that to the whole ecosystem (host ports labeled with their owning
   **container**, plus WSL distros), so use them to find collisions and unmanaged services; `adopt`
   one to bring it into the registry. If you see stale entries, `portbook gc` reclaims dead/expired
   ones. `portbook serve` opens a live web dashboard of all of the above.
6. **Never free a port by killing what's on it.** If a port you need is HELD by another project
   (reserved, or inside its block), do not kill its process and do not grab the port — **ask**:
   ```bash
   portbook request --port <p> --from <your-project> --reason "<why you need it>"
   ```
   Add `--wait [--timeout <sec>]` to block for the verdict: a **grant** is claimed automatically and
   the port prints on stdout; a **deny**/timeout exits 1 with the holder's note. Without `--wait`,
   poll `portbook requests --from <your-project>` and proceed only when the verdict is **granted** —
   the port is then held for you; claim it with a normal `reserve`. A **denied** verdict (read the
   holder's note) means pick another port. The flip side: when you hold contested ports, answer asks —
   `portbook list` nags when your inbox has any; check `portbook inbox --project <your-project>` at
   natural pauses and answer each with `portbook grant <id>` or `portbook deny <id> [--note "..."]`.
7. **Scripting?** Add `--json` to `reserve`/`list`/`inbox`/`requests`/`log` (and `check` is always
   JSON) so you can parse the result instead of scraping columns — e.g. `portbook list --json` gives
   each port's `bound`/`stale` state.
8. **When something looks wrong,** `portbook doctor` is the one-shot health check (nonzero exit on
   real problems: block intrusions, origin collisions, an unreachable fleet server) and
   `portbook log` is the audit trail — who reserved/released/reclaimed which port, when, and why
   (`--port <p>` for one port's history). Check the trail before assuming another agent misbehaved.
   To drop this convention into a new project: `portbook init --write`.

## Known reserved blocks (do not bind these unless they're yours)
List your project's long-lived ports — or the **range** it owns — here as you adopt them. Prefer
claiming the range as a portbook *block* (`portbook block --project <p> --range <a-b>`) so the
registry enforces it, then note it here for humans. For example:
- **myapp** → block `4000-4099` (api / web / admin origins). The live source of truth is always
  `portbook list` / `portbook blocks`.

## Why
One machine, many agents. Without a shared registry, every server is a guess. portbook turns "what
port is free?" into a single, OS-reconciled answer that every agent shares.
