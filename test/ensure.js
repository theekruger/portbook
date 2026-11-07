// Permanent, named service assignments: actual concurrent processes and CLI use.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL("../bin/portbook.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = { project: "pilot", service: "web", host: "127.0.0.1", rangeStart: 44000, rangeEnd: 44999 };
for (const key of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[key];

if (process.argv[2] === "worker") {
  const [service, index, gate] = process.argv.slice(3);
  const { ensure } = await import("../src/registry.js");
  fs.writeFileSync(`${gate}.${index}.ready`, "ready");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(gate)) {
    if (Date.now() > deadline) throw new Error("request barrier timed out");
    await sleep(5);
  }
  console.log(JSON.stringify((await ensure({ ...options, service }))[0]));
} else {
  process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-ensure-"));
  const { ensure, reserve, readRegistry, FILE, DIR } = await import("../src/registry.js");
  const exec = promisify(execFile);
  let checks = 0, barrier = 0;
  const equal = (a, b) => { assert.deepEqual(a, b); checks++; };
  const rejects = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++; };
  let server;
  async function concurrent(services) {
    const gate = path.join(DIR, `gate-${barrier++}`);
    const children = services.map((service, index) => spawn(process.execPath, [self, "worker", service, String(index), gate], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    }));
    const completed = children.map((child) => new Promise((resolve, reject) => {
      let output = "", error = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { error += data; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(error || `worker exited ${code}`));
        else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } }
      });
    }));
    // Handle early failures while the parent is still waiting for ready markers.
    const results = Promise.all(completed);
    results.catch(() => {});
    try {
      const deadline = Date.now() + 10000;
      while (!services.every((_, index) => fs.existsSync(`${gate}.${index}.ready`))) {
        if (Date.now() > deadline) throw new Error("workers did not reach the barrier");
        await sleep(5);
      }
      fs.writeFileSync(gate, "go");
      return await results;
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }

  try {
    const [first] = await ensure(options);
    const before = fs.readFileSync(FILE, "utf8");
    const auditBefore = fs.readFileSync(path.join(DIR, "events.jsonl"), "utf8");
    equal((await ensure(options))[0], first);
    equal(fs.readFileSync(FILE, "utf8"), before);
    equal(fs.readFileSync(path.join(DIR, "events.jsonl"), "utf8"), auditBefore);
    equal(first.service, "web");
    equal(first.pid, null);
    equal(first.expiresAt, null);

    // Retrieval must work while the app is listening; it must not probe/reassign.
    server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(first.port, "127.0.0.1", resolve); });
    equal((await ensure(options))[0].port, first.port);
    const [api] = await ensure({ ...options, service: "api" });
    equal(api.port !== first.port, true);
    await rejects(() => ensure({ ...options, port: api.port }), /already assigned port/);
    await rejects(() => ensure({ ...options, host: "0.0.0.0" }), /already assigned host/);
    await new Promise((resolve) => server.close(resolve)); server = null;

    // A fresh CLI process retrieves the same permanent assignment after stop.
    const args = [cli, "ensure", "--project", "pilot", "--service", "web", "--host", "127.0.0.1", "--json"];
    equal(JSON.parse((await exec(process.execPath, args, { env: process.env })).stdout)[0].id, first.id);
    equal(/\bensure\b/.test((await exec(process.execPath, [cli, "completion", "bash"], { env: process.env })).stdout), true);
    const remoteEnv = { ...process.env, PORTBOOK_SERVER: "http://127.0.0.1:1" };
    await rejects(() => exec(process.execPath, args, { env: remoteEnv }), /local registries only/);

    for (const bad of [undefined, "", " ", true, "a\nb", "a".repeat(81)]) {
      await rejects(() => ensure({ ...options, service: bad }), /service name/);
    }
    for (const lifetime of [{ count: 2 }, { pid: process.pid }, { ttlSec: 60 }]) {
      await rejects(() => ensure({ ...options, ...lifetime }), /permanent assignment/);
    }
    await rejects(() => ensure({ ...options, machine: "" }), /machine name/);
    const [remote] = await ensure({ ...options, machine: "other-machine", port: first.port, probe: false });
    equal(remote.id !== first.id, true);
    equal((await ensure({ ...options, machine: "other-machine" }))[0].id, remote.id);

    // The original creation API keeps creating independent holds.
    const [one] = await reserve({ ...options, project: "ordinary" });
    const [two] = await reserve({ ...options, project: "ordinary" });
    equal(one.port !== two.port, true);
    equal(Object.hasOwn(one, "service"), false);

    const pair = await concurrent(["pair-a", "pair-b"]);
    equal(new Set(pair.map((r) => r.port)).size, 2);
    const same = await concurrent(["same-service", "same-service"]);
    equal(same[0].id, same[1].id);
    const burst = await concurrent(Array.from({ length: 10 }, (_, i) => `burst-${i}`));
    equal(new Set(burst.map((r) => r.port)).size, 10);
    equal(readRegistry().reservations.filter((r) => r.service === "same-service").length, 1);

    console.log(`ensure: ${checks} checks passed`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}
