// portbook ⇄ WSL — enumerate WSL distros and, crucially, the TCP ports LISTENING INSIDE them.
//
// Why this matters for reservations: WSL2 forwards localhost — a server bound inside a distro is
// reachable (and collidable) on the Windows host's 127.0.0.1, so "conflicts are per-machine" is WRONG
// across the WSL boundary: the host and its distros share one effective localhost port namespace.
// Worse, the host's own bind test can SUCCEED on a port a distro is serving (the relay isn't always
// in the host listener table), silently shadowing the WSL service. So reserve() treats in-WSL
// listeners as taken, and scan()/doctor surface them.
//
// Everything here is best-effort, guarded, and dependency-free, in the same spirit as
// environments.js: a missing/odd `wsl.exe` (or a non-Windows host) just means empty results. This
// module imports nothing from registry.js/environments.js, so BOTH can import it without a cycle.
// Set $PORTBOOK_NO_WSL=1 to skip all WSL probing (e.g. if `wsl.exe` is slow on your machine).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const onWindows = () => process.platform === "win32" && !process.env.PORTBOOK_NO_WSL;

// ── pure parsers (unit-testable on any OS) ─────────────────────────────────────────────────────────

// Parse raw `wsl.exe -l -v` bytes. wsl emits UTF-16LE by default but honors WSL_UTF8=1 (plain
// UTF-8) — sniff instead of assuming: this ASCII-range table always interleaves NUL high bytes in
// UTF-16LE, and valid UTF-8 text never contains NUL. The STATE column can be multiword on localized
// Windows ("Wird ausgeführt"), so match it lazily up to the trailing VERSION.
export function parseWslList(buf) {
  const text = buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8");
  const out = [];
  for (const line of text.split(/\r?\n/).slice(1)) { // skip the header row
    const m = line.match(/^(\*?)\s*(\S+)\s+(.+?)\s+(\d+)\s*$/);
    if (m) out.push({ name: m[2], state: m[3], version: Number(m[4]), default: m[1] === "*" });
  }
  return out;
}

// Parse `wsl.exe -l --running -q` bytes — one distro name per line, no header, locale-independent
// (the whole point: `-l -v`'s STATE column is localized, so "Running" can't be matched reliably).
export function parseWslRunning(buf) {
  const text = buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8");
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Parse concatenated /proc/net/tcp + /proc/net/tcp6 into the set of ports in LISTEN state (st 0A).
// Data rows look like `  0: 0100007F:1F90 00000000:0000 0A ...` — local_address is hex ip:port.
// Header rows ("sl local_address ...") and garbage fall out of the shape checks.
export function parseProcNetTcp(text) {
  const ports = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4 || !/^[0-9a-fA-F:.]+:[0-9a-fA-F]+$/.test(t[1] || "") || t[3] !== "0A") continue;
    const port = parseInt(t[1].slice(t[1].lastIndexOf(":") + 1), 16);
    if (port) ports.add(port);
  }
  return ports;
}

// ── shell-out wrappers (Windows only; [] / empty elsewhere or on any failure) ──────────────────────

// Installed distros with state/version, for the ecosystem view.
export async function getWsl() {
  if (!onWindows()) return [];
  try {
    const { stdout } = await pexec("wsl.exe", ["-l", "-v"], { timeout: 8000, maxBuffer: 1 << 20, encoding: "buffer" });
    return parseWslList(stdout);
  } catch { return []; }
}

// Names of the distros running RIGHT NOW. Only these are probed for ports — `wsl -d <stopped>`
// would BOOT the distro, a slow side effect an innocent `portbook reserve` must never trigger.
export async function runningDistros() {
  if (!onWindows()) return [];
  try {
    const { stdout } = await pexec("wsl.exe", ["-l", "--running", "-q"], { timeout: 8000, maxBuffer: 1 << 20, encoding: "buffer" });
    return parseWslRunning(stdout);
  } catch { return []; }
}

// TCP ports listening inside each RUNNING distro, as Map<port, distroName> (first distro to hold a
// port wins). Reads /proc/net/tcp{,6} directly — present in every Linux distro, no ss/netstat needed.
export async function wslListenerPorts() {
  const out = new Map();
  if (!onWindows()) return out;
  for (const name of await runningDistros()) {
    try {
      const { stdout } = await pexec(
        "wsl.exe", ["-d", name, "-e", "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"],
        { timeout: 5000, maxBuffer: 1 << 22 }
      );
      for (const p of parseProcNetTcp(stdout)) if (!out.has(p)) out.set(p, name);
    } catch { /* distro without sh/proc (rare) or wsl hiccup — skip it */ }
  }
  return out;
}
