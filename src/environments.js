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

const pexec = promisify(execFile);

// Parse a docker/nerdctl "Ports" string, e.g.
//   "127.0.0.1:6379->6379/tcp, 0.0.0.0:8025->8025/tcp, [::]:8025->8025/tcp, 6380/tcp"
// into published host mappings and internal-only (exposed but not published) ports. IPv4/IPv6
// duplicates of the same host port collapse to one entry.
export function parsePorts(s) {
  const published = new Map(); // hostPort -> mapping
  const internal = new Map();  // containerPort -> mapping
  for (const part of String(s || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const pub = part.match(/^(?:(\[[^\]]+\]|[\d.]+):)?(\d+)->(\d+)\/(\w+)$/);
    if (pub) {
      const hostPort = Number(pub[2]);
      if (!published.has(hostPort)) published.set(hostPort, { hostIp: pub[1] || null, hostPort, containerPort: Number(pub[3]), proto: pub[4] });
      continue;
    }
    const ex = part.match(/^(\d+)\/(\w+)$/);
    if (ex) { const cp = Number(ex[1]); if (!internal.has(cp)) internal.set(cp, { containerPort: cp, proto: ex[2] }); }
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

// WSL distros (Windows only). Informational: ports INSIDE a distro aren't visible from here without a
// reporter running in it — but WSL2 auto-forwards many to localhost, so they often appear as host
// listeners owned by `wslrelay.exe`. We surface the distros so the picture is complete.
export async function getWsl() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await pexec("wsl.exe", ["-l", "-v"], { timeout: 8000, maxBuffer: 1 << 20, encoding: "utf16le" });
    const out = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) { // skip the header row
      const m = line.match(/^(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/);
      if (m) out.push({ name: m[2], state: m[3], version: Number(m[4]), default: m[1] === "*" });
    }
    return out;
  } catch { return []; }
}

// The whole picture for THIS machine: every host listener (labeled with its owning container or
// process and any portbook reservation), the containers (with published + internal ports), WSL
// distros, and "ghost" reservations (reserved but nothing is listening). Read-only.
export async function ecosystem() {
  const [listeners, containerInfo, wsl] = await Promise.all([getListeners(), getContainers(), getWsl()]);
  const { containers, runtimes } = containerInfo;
  const reservations = list();

  const resByPort = new Map(reservations.map((r) => [r.port, r]));
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

  const ghosts = reservations.filter((r) => !seen.has(r.port)).sort((a, b) => a.port - b.port);

  return {
    machine: machineName(),
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
