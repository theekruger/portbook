# Port convention for agents (portbook)

If you (an AI agent or a script) start a server/process that binds a TCP port on this machine, you
MUST coordinate through **portbook** so you don't collide with other agents or projects. This is the
rule that prevents incidents like one agent silently killing another project's running servers.

## The rule
1. **Reserve before you bind.** Pick a free port via portbook, then bind that exact port — never
   hardcode a port without reserving it first.
   ```bash
   PORT=$(portbook reserve --project <project> --count 1 --owner <agent> --purpose "<what>")
   # ...start your server on $PORT...
   ```
   Or claim a specific port (fails loudly if it's taken):
   ```bash
   portbook reserve --project <project> --port 4100 --owner <agent> --purpose "<what>"
   ```
2. **Record the PID** when you can (`--pid <serverPid>`) so a crash auto-frees the port on the next
   `reserve`/`gc`. For ephemeral work, use a TTL (`--ttl 3600`).
3. **Release on stop.** `portbook release --project <project>` (or `--port <p>`).
4. **Before touching a port you didn't reserve,** run `portbook check <port>` and `portbook list`
   (the **BOUND** column shows what's actually listening right now). `portbook scan` shows *every*
   listening port on the machine — including ones nobody reserved — and `portbook env` widens that to
   the whole ecosystem (host ports labeled with their owning **container**, plus WSL distros), so use
   them to find collisions and unmanaged services. If you see stale entries, `portbook gc` reclaims
   dead/expired ones. `portbook serve` opens a live web dashboard of all of the above.
5. **Scripting?** Add `--json` to `reserve`/`list` (and `check` is always JSON) so you can parse the
   result instead of scraping columns — e.g. `portbook list --json` gives each port's `bound`/`stale`
   state.

## Known reserved blocks (do not bind these unless they're yours)
List your project's long-lived ports here as you adopt them, for example:
- **myapp** → `4000`, `4001`, `4002` (api / web / admin origins). The live source of truth is always
  `portbook list`.

## Why
One machine, many agents. Without a shared registry, every server is a guess. portbook turns "what
port is free?" into a single, OS-reconciled answer that every agent shares.
