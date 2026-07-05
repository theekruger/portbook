// WSL shared-port-namespace test — the pure parsers behind the reserve-time WSL check (WSL2 forwards
// distro localhost to the host, so in-distro listeners are real collision surface). Hermetic: no
// wsl.exe needed on any OS. The shell-out wrappers are exercised implicitly by reserve() on Windows
// dev machines and guarded to return empty everywhere else.
import { parseProcNetTcp, parseWslRunning, parseWslList, wslListenerPorts } from "../src/wsl.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

// /proc/net/tcp{,6}: LISTEN rows (st 0A) yield their hex-decoded local port; everything else is noise.
{
  const sample = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0", // 127.0.0.1:8080 LISTEN
    "   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 0", // 0.0.0.0:3000 LISTEN
    "   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 20 4 30 10 -1", // ESTABLISHED — skip
    "  sl  local_address                         remote_address                        st ...", // tcp6 header
    "   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12348 1 0000000000000000 100 0 0 10 0", // [::]:8081 LISTEN
  ].join("\n");
  const ports = parseProcNetTcp(sample);
  ok("LISTEN rows decode their hex port (v4 + v6)", ports.has(8080) && ports.has(3000) && ports.has(8081));
  ok("non-LISTEN and header rows are skipped", ports.size === 3);
  ok("garbage → empty set (no throw)", parseProcNetTcp("nope\n\n").size === 0 && parseProcNetTcp("").size === 0);
}

// `wsl -l --running -q` output: UTF-16LE by default, UTF-8 under WSL_UTF8=1 — both sniffed.
{
  const utf16 = Buffer.from("Ubuntu\r\ndocker-desktop\r\n", "utf16le");
  const utf8 = Buffer.from("Ubuntu\n", "utf8");
  ok("running distros parse from UTF-16LE", JSON.stringify(parseWslRunning(utf16)) === '["Ubuntu","docker-desktop"]');
  ok("running distros parse from UTF-8", JSON.stringify(parseWslRunning(utf8)) === '["Ubuntu"]');
  ok("empty output → no distros", parseWslRunning(Buffer.from("", "utf8")).length === 0);
}

// `wsl -l -v` still parses from its new home (environments.js re-exports this for compat).
{
  const table = Buffer.from("  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Wird ausgeführt 2\n", "utf8");
  const rows = parseWslList(table);
  ok("wsl -l -v parses names/states/versions", rows.length === 2 && rows[0].name === "Ubuntu" && rows[0].default === true);
  ok("localized multiword STATE survives", rows[1].state === "Wird ausgeführt" && rows[1].version === 2);
}

// The live wrapper is a no-op off-Windows and under PORTBOOK_NO_WSL — and never throws either way.
{
  process.env.PORTBOOK_NO_WSL = "1";
  const m = await wslListenerPorts();
  ok("PORTBOOK_NO_WSL=1 short-circuits to an empty map", m instanceof Map && m.size === 0);
  delete process.env.PORTBOOK_NO_WSL;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
