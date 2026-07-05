// portbook environment providers — enumerate the sub-environments running on THIS machine
// (containers today; WSL distros are detected and surfaced) and fold them into a single ecosystem
// view alongside the host's own listeners and the portbook registry.
//
// Everything here is best-effort and dependency-free: we shell out to tools you already have
// (`docker`, `nerdctl`, `wsl`) and skip silently if they're absent or not responding. Nothing throws
// outward — a missing runtime just means an empty list.
//
// What is and isn't discoverable from the host (by design — see docs/FLEET.md):
//   • Containers  — discoverable here: we read each container's PUBLISHED port map (host->container).
//   • VMs / inside-WSL / other machines — NOT introspectable from outside. The model for those is a
//     lightweight portbook reporter running inside, reporting up to `portbook serve` (fleet mode).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { list, getListeners, machineName } from "./registry.js";
import { parseWslList, getWsl } from "./wsl.js";
// WSL enumeration lives in src/wsl.js (registry.js needs it too for the reserve-time WSL port check,
// and importing environments.js from there would be the cycle CLAUDE.md forbids). Re-exported here so
// existing importers (`portbook/environments`) keep working.
export { parseWslList, getWsl };

const pexec = promisify(execFile);

// Parse a docker/nerdctl "Ports" string, e.g.
//   "127.0.0.1:6379->6379/tcp, 0.0.0.0:8025->8025/tcp, [::]:8025->8025/tcp, 6380/tcp"
// into published host mappings and internal-only (exposed but not published) ports. IPv4/IPv6
// duplicates of the same host port collapse to one entry. Docker compresses contiguous ranges
// ("0.0.0.0:8000-8005->8000-8005/tcp", internal "8000-8005/tcp") — expand those to per-port
// mappings, paired positionally, capped so a pathological `-p 1-65535` can't balloon the result.
const RANGE_CAP = 256; // max ports expanded per ranged token
export function parsePorts(s) {
  const published = new Map(); // hostPort -> mapping
  const internal = new Map();  // containerPort -> mapping
  for (const part of String(s || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const pub = part.match(/^(?:(\[[^\]]+\]|[\d.]+):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/);
    if (pub) {
      const h0 = Number(pub[2]), h1 = pub[3] ? Number(pub[3]) : h0, c0 = Number(pub[4]);
      for (let i = 0; i <= Math.min(h1 - h0, RANGE_CAP - 1); i++) {
        const hostPort = h0 + i;
        if (!published.has(hostPort)) published.set(hostPort, { hostIp: pub[1] || null, hostPort, containerPort: c0 + i, proto: pub[6] });
      }
      continue;
    }
    const ex = part.match(/^(\d+)(?:-(\d+))?\/(\w+)$/);
    if (ex) {
      const a = Number(ex[1]), b = ex[2] ? Number(ex[2]) : a;
      for (let i = 0; i <= Math.min(b - a, RANGE_CAP - 1); i++) {
        const cp = a + i;
        if (!internal.has(cp)) internal.set(cp, { containerPort: cp, proto: ex[3] });
      }
    }
  }
  return { published: [...published.values()], internal: [...internal.values()] };
}

function normalizeContainer(runtime, r) {
  const { published, internal } = parsePorts(r.Ports);
  return {
    runtime,
    id: (r.ID || r.Id || "").slice(0, 12),
    name: r.Names || r.Name || "(unnamed)",
    image: r.Image || "",
    status: r.Status || r.State || "",
    ports: published,
    internalPorts: internal,
  };
}

async function psJson(runtime) {
  try {
    const { stdout } = await pexec(runtime, ["ps", "--no-trunc", "--format", "{{json .}}"], { timeout: 8000, maxBuffer: 1 << 22 });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => normalizeContainer(runtime, JSON.parse(line)));
  } catch { return null; } // runtime absent, daemon down, or unsupported --format
}

// Running containers across the runtimes we can find. Rancher Desktop exposes both `docker` and
// `nerdctl` against the same backend, so we dedupe by container id. `runtimes` lists which CLIs
// actually answered (so the UI can say "docker: yes, 2 containers" even when zero are running).
export async function getContainers() {
  const runtimes = [];
  const byId = new Map();
  for (const rt of ["docker", "nerdctl", "podman"]) {
    const cs = await psJson(rt);
    if (cs == null) continue;
    runtimes.push(rt);
    for (const c of cs) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
  }
  return { containers: [...byId.values()], runtimes };
}

// The whole picture for THIS machine: every host listener (labeled with its owning container or
// process and any portbook reservation), the containers (with published + internal ports), WSL
// distros, and "ghost" reservations (reserved but nothing is listening). Read-only.
export async function ecosystem() {
  const [listeners, containerInfo, wsl] = await Promise.all([getListeners(), getContainers(), getWsl()]);
  const { containers, runtimes } = containerInfo;
  const reservations = list();
  const me = machineName();
  // Cross-reference only THIS machine's rows (legacy machine-less rows are local), mirroring scan():
  // on a fleet host the ledger holds every machine's rows — a remote hold must not label a local
  // listener "managed", and a live remote reservation must never surface as a releasable "ghost".
  const mine = reservations.filter((r) => !r.machine || r.machine === me);

  const resByPort = new Map(mine.map((r) => [r.port, r]));
  const containerByHostPort = new Map();
  for (const c of containers) for (const p of c.ports) {
    if (!containerByHostPort.has(p.hostPort)) containerByHostPort.set(p.hostPort, { name: c.name, image: c.image, runtime: c.runtime, containerPort: p.containerPort, proto: p.proto });
  }

  const seen = new Set();
  const ports = listeners.map((l) => {
    seen.add(l.port);
    const container = containerByHostPort.get(l.port) || null;
    const reservation = resByPort.get(l.port) || null;
    const kind = reservation ? "managed" : container ? "container" : "unmanaged";
    return { port: l.port, pid: l.pid, proc: l.proc, container, reservation, kind };
  }).sort((a, b) => a.port - b.port);

  const ghosts = mine.filter((r) => !seen.has(r.port)).sort((a, b) => a.port - b.port);

  return {
    machine: me,
    at: new Date().toISOString(),
    runtimes: { docker: runtimes.includes("docker"), nerdctl: runtimes.includes("nerdctl"), podman: runtimes.includes("podman"), wsl: wsl.length > 0 },
    summary: {
      listening: ports.length,
      managed: ports.filter((p) => p.kind === "managed").length,
      container: ports.filter((p) => p.kind === "container").length,
      unmanaged: ports.filter((p) => p.kind === "unmanaged").length,
      ghosts: ghosts.length,
      containers: containers.length,
    },
    ports,
    ghosts,
    containers,
    wsl,
  };
}
