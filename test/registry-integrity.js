// A failed read must never turn a subsequent request into a fresh empty ledger.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
for (const key of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[key];
process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-integrity-"));
const { readRegistry, reserve, ensure, list, gc, FILE, DIR } = await import("../src/registry.js");
let checks = 0;
try {
  const valid = { version: 1, reservations: [{ id: "original", project: "app", port: 44001 }] };
  fs.writeFileSync(FILE, JSON.stringify(valid));
  const original = fs.readFileSync(FILE, "utf8");
  const legacy = readRegistry();
  for (const field of ["blocks", "requests", "origins"]) { assert.deepEqual(legacy[field], []); checks++; }
  assert.equal(fs.readFileSync(FILE, "utf8"), original); checks++;

  const damaged = ["{ invalid", "null", "[]", "{}",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, reservations: "damaged" }),
    JSON.stringify({ ...valid, blocks: {} }),
    JSON.stringify({ ...valid, requests: null }),
    JSON.stringify({ ...valid, origins: 5 }),
    JSON.stringify({ ...valid, reservations: [null] }),
    JSON.stringify({ ...valid, reservations: [{ project: "app", port: 99999 }] }),
    JSON.stringify({ ...valid, reservations: [...valid.reservations, { project: "another", port: 44001 }] }),
    JSON.stringify({ ...valid, reservations: [{ project: "app", service: "web", port: 44001 }, { project: "app", service: "web", port: 44002 }] }),
  ];
  for (const bytes of damaged) {
    fs.writeFileSync(FILE, bytes);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(readRegistry, /corrupt/); checks++;
      assert.throws(list, /corrupt/); checks++;
      await assert.rejects(() => reserve({ project: "new", port: 44002, adopt: true }), /corrupt/); checks++;
      await assert.rejects(() => ensure({ project: "new", service: "web", port: 44002 }), /corrupt/); checks++;
      await assert.rejects(gc, /corrupt/); checks++;
      assert.equal(fs.readFileSync(FILE, "utf8"), bytes); checks++;
    }
    assert.equal(fs.readdirSync(DIR).some((name) => name.startsWith("registry.json.corrupt-")), false); checks++;
  }
  // A port number may legitimately be held on different machines.
  fs.writeFileSync(FILE, JSON.stringify({ ...valid, reservations: [
    { project: "app", service: "web", machine: "A", port: 44001 },
    { project: "app", service: "web", machine: "B", port: 44001 },
  ] }));
  assert.equal(readRegistry().reservations.length, 2); checks++;
  console.log(`registry-integrity: ${checks} checks passed`);
} finally { fs.rmSync(DIR, { recursive: true, force: true }); }
