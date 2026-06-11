// Tests for the OS listener-table parsers (pure text/JSON → [{port, pid, proc}]).
// These run identically on any OS because they feed CAPTURED sample output instead of shelling out,
// so the Linux/macOS/Windows parsing paths are all exercised regardless of the host platform.
// Tests must not inherit fleet config (docs/FLEET.md tells users to export these in the profile) —
// scrub BEFORE importing src modules, hence the dynamic import.
for (const k of ["PORTBOOK_SERVER", "PORTBOOK_TOKEN", "PORTBOOK_MACHINE"]) delete process.env[k];
const { parseSs, parseLsof, parseNetstat, parsePowershell } = await import("../src/registry.js");
const { parseWslList } = await import("../src/environments.js");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const find = (rows, port) => rows.find((r) => r.port === port);

// ── ss -tlnpH (Linux) ─────────────────────────────────────────────────────────────────────────────
{
  const sample = [
    'LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=1234,fd=6))',
    'LISTEN 0 511  0.0.0.0:80    0.0.0.0:* users:(("nginx",pid=900,fd=8),("nginx",pid=901,fd=8))',
    'LISTEN 0 128  [::]:8080     [::]:*    users:(("java",pid=4242,fd=120))',
    'LISTEN 0 128  *:22          *:*', // sshd with no users:(()) field (not run as root → no pid/proc)
  ].join("\n");
  const rows = parseSs(sample);

  ok("ss: parses every LISTEN row", rows.length === 4);
  ok("ss: IPv4 host:port → port + pid + proc", (() => { const r = find(rows, 6379); return r && r.pid === 1234 && r.proc === "redis-server"; })());
  ok("ss: wildcard 0.0.0.0:80 → port 80, first pid wins", (() => { const r = find(rows, 80); return r && r.pid === 900 && r.proc === "nginx"; })());
  ok("ss: IPv6 [::]:8080 → port 8080 (last ':' segment)", (() => { const r = find(rows, 8080); return r && r.pid === 4242 && r.proc === "java"; })());
  ok("ss: row without users:(()) → pid/proc null", (() => { const r = find(rows, 22); return r && r.pid === null && r.proc === null; })());
  ok("ss: ports are numbers", rows.every((r) => typeof r.port === "number" && Number.isInteger(r.port)));
}

// ── ss dedupe (same host port on two interfaces — first occurrence wins) ─────────────────────────────
{
  const sample = [
    'LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* users:(("redis-a",pid=11,fd=6))',
    'LISTEN 0 4096 [::1]:6379     [::]:*    users:(("redis-b",pid=22,fd=6))',
  ].join("\n");
  const rows = parseSs(sample);
  ok("ss: dedupes the same port across interfaces", rows.length === 1);
  ok("ss: dedupe keeps the FIRST row's pid/proc", (() => { const r = find(rows, 6379); return r && r.pid === 11 && r.proc === "redis-a"; })());
}

// ── lsof -nP -iTCP -sTCP:LISTEN (macOS/BSD) ─────────────────────────────────────────────────────────
{
  const sample = [
    "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "node     4100 ctk   23u  IPv4 0x1a2b3c4d5e6f7890      0t0  TCP 127.0.0.1:4100 (LISTEN)",
    "Postgres  812 ctk    7u  IPv6 0x0987654321fedcba      0t0  TCP [::1]:5432 (LISTEN)",
    "controlce 678 ctk   18u  IPv4 0xdeadbeefdeadbeef      0t0  TCP *:7000 (LISTEN)",
  ].join("\n");
  const rows = parseLsof(sample);

  ok("lsof: skips the header line", rows.length === 3);
  ok("lsof: IPv4 127.0.0.1:4100 → port + pid + command", (() => { const r = find(rows, 4100); return r && r.pid === 4100 && r.proc === "node"; })());
  ok("lsof: IPv6 [::1]:5432 → port 5432", (() => { const r = find(rows, 5432); return r && r.pid === 812 && r.proc === "Postgres"; })());
  ok("lsof: wildcard *:7000 → port 7000", (() => { const r = find(rows, 7000); return r && r.pid === 678 && r.proc === "controlce"; })());
  ok("lsof: ports are numbers", rows.every((r) => typeof r.port === "number" && Number.isInteger(r.port)));
}

// ── netstat -ano (Windows) ──────────────────────────────────────────────────────────────────────────
{
  const sample = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032",
    "  TCP    127.0.0.1:4100         0.0.0.0:0              LISTENING       17640",
    "  TCP    [::]:445               [::]:0                 LISTENING       4",
    "  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4",
    "  TCP    127.0.0.1:50000        127.0.0.1:4100         ESTABLISHED     17640", // not LISTENING → skip
    "  UDP    0.0.0.0:5353           *:*                                    2200",  // not TCP → skip
  ].join("\r\n"); // Windows tools emit CRLF
  const rows = parseNetstat(sample);

  ok("netstat: keeps only TCP LISTENING rows", rows.length === 4);
  ok("netstat: 0.0.0.0:135 → port 135, pid 1032", (() => { const r = find(rows, 135); return r && r.pid === 1032; })());
  ok("netstat: IPv6 [::]:445 → port 445, pid 4", (() => { const r = find(rows, 445); return r && r.pid === 4; })());
  ok("netstat: skips ESTABLISHED rows", find(rows, 50000) === undefined);
  ok("netstat: skips UDP rows", find(rows, 5353) === undefined);
  ok("netstat: proc is always null (netstat has no name)", rows.every((r) => r.proc === null));
  ok("netstat: ports are numbers", rows.every((r) => typeof r.port === "number" && Number.isInteger(r.port)));
}

// ── netstat dedupe (IPv4 + IPv6 of the same port) ───────────────────────────────────────────────────
{
  const sample = [
    "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       500",
    "  TCP    [::]:8080              [::]:0                 LISTENING       501",
  ].join("\r\n");
  const rows = parseNetstat(sample);
  ok("netstat: dedupes the same port, first pid wins", rows.length === 1 && find(rows, 8080).pid === 500);
}

// ── PowerShell / Get-NetTCPConnection (Windows preferred path — JSON) ────────────────────────────────
{
  const arr = parsePowershell('[{"port":3000,"pid":17640,"proc":"node"},{"port":5432,"pid":812,"proc":"postgres"}]');
  ok("powershell: JSON array → rows", arr.length === 2);
  ok("powershell: maps port/pid/proc", (() => { const r = find(arr, 3000); return r && r.pid === 17640 && r.proc === "node"; })());
  ok("powershell: ports are numbers", arr.every((r) => typeof r.port === "number" && Number.isInteger(r.port)));

  // ConvertTo-Json emits a bare object (not an array) for a single connection — must still parse.
  const one = parsePowershell('{"port":6379,"pid":1234,"proc":"redis-server"}');
  ok("powershell: single object (not array) → one row", one.length === 1 && one[0].port === 6379);

  // A null proc (Get-Process failed) must normalize to null, not the string "null".
  const noProc = parsePowershell('{"port":135,"pid":1032,"proc":null}');
  ok("powershell: null proc stays null", noProc.length === 1 && noProc[0].proc === null);

  // Empty stdout (the `|| "[]"` guard) and an empty array both yield [].
  ok("powershell: empty stdout → []", parsePowershell("").length === 0 && parsePowershell("   ").length === 0);
  ok("powershell: empty array → []", parsePowershell("[]").length === 0);
}

// ── wsl.exe -l -v (Windows) — raw bytes, encoding sniffed ───────────────────────────────────────────
{
  // wsl emits UTF-16LE by default but UTF-8 under WSL_UTF8=1; parseWslList must decode BOTH from the
  // raw bytes (the old unconditional utf16le decode turned WSL_UTF8=1 output into mojibake → []).
  const table = [
    "  NAME                    STATE           VERSION",
    "* Ubuntu                  Running         2",
    "  rancher-desktop-data    Stopped         2",
    "",
  ].join("\r\n");
  const w16 = parseWslList(Buffer.from(table, "utf16le"));
  ok("wsl: decodes default UTF-16LE output", w16.length === 2 && w16[0].name === "Ubuntu" && w16[0].state === "Running" && w16[0].version === 2);
  ok("wsl: '*' marks the default distro", w16[0].default === true && w16[1].default === false);
  const w8 = parseWslList(Buffer.from(table, "utf8"));
  ok("wsl: decodes WSL_UTF8=1 (plain UTF-8) output", w8.length === 2 && w8[1].name === "rancher-desktop-data" && w8[1].state === "Stopped");

  // Localized Windows renders STATE as multiple words (German "Wird ausgeführt") — must still parse.
  const de = parseWslList(Buffer.from("  NAME      STATUS              VERSION\r\n* Ubuntu    Wird ausgeführt     2\r\n", "utf16le"));
  ok("wsl: accepts multiword localized states", de.length === 1 && de[0].state === "Wird ausgeführt" && de[0].version === 2);

  ok("wsl: empty/garbage input → [] (no throw)", parseWslList(Buffer.from("", "utf8")).length === 0 && parseWslList(Buffer.from("no distros installed\r\n", "utf16le")).length === 0);
}

// ── malformed / empty input is skipped, never throws ─────────────────────────────────────────────────
{
  ok("ss: blank/garbage input → [] (no throw)", parseSs("").length === 0 && parseSs("\n\n   \n").length === 0);
  ok("ss: a junk line is skipped", parseSs("this is not an ss line\nLISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* users:((\"r\",pid=1,fd=6))").length === 1);
  ok("lsof: blank input → [] (no throw)", parseLsof("").length === 0 && parseLsof("HEADER ONLY\n").length === 0);
  ok("lsof: short/garbage line (<9 cols) is skipped", parseLsof("HEADER\nnode 4100 ctk 23u (LISTEN)").length === 0);
  ok("netstat: blank input → [] (no throw)", parseNetstat("").length === 0 && parseNetstat("garbage\nmore garbage").length === 0);
  ok("netstat: a TCP line with no PID column is tolerated", (() => {
    // A degenerate "TCP ... LISTENING" line with a non-numeric trailing token → pid null, still no throw.
    const rows = parseNetstat("  TCP    0.0.0.0:1   0.0.0.0:0   LISTENING   x");
    return rows.length === 1 && rows[0].port === 1 && rows[0].pid === null;
  })());
  // parsePowershell parses JSON, so invalid JSON throws by design — getListeners() catches it and falls
  // back to netstat. Assert the contract: malformed JSON throws (the wrapper, not the parser, recovers).
  let threw = false;
  try { parsePowershell("not json"); } catch { threw = true; }
  ok("powershell: invalid JSON throws (wrapper falls back to netstat)", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
