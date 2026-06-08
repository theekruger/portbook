// Smoke test for the portbook VS Code extension — exercises the REAL extension.js (CommonJS,
// require('vscode')) WITHOUT a running VS Code, by mocking the 'vscode' module and pointing the
// extension at a genuinely-running portbook backend (registry + HTTP server) on a throwaway dir.
//
// Run: node integrations/vscode/test-extension.mjs
//
// What it proves end-to-end:
//   • activate(ctx) wires up the tree provider, status bar, and all four commands without throwing.
//   • The tree provider's getChildren() fetches /api/ecosystem from a real server and renders a row
//     reflecting a real reservation (both the "managed"/listening row and the "ghost" row paths).
//   • The status bar text reflects the live managed-port count.
//   • The "portbook.refresh" command re-fetches and the view stays consistent.
//   • Cancelling Reserve (showInputBox -> undefined) is a no-op; Open Dashboard calls env.openExternal.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import Module from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  PASS " + name)) : (fail++, console.log("  FAIL " + name)); };

// ---------------------------------------------------------------------------------------------
// 1) Stand up a real portbook backend on a throwaway registry dir, with a genuinely-bound port.
// ---------------------------------------------------------------------------------------------

process.env.PORTBOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portbook-vscode-test-"));
// Deterministic machine name so the assertions don't depend on the host's hostname.
process.env.PORTBOOK_MACHINE = "vscode-smoke-host";

const { reserve } = await import(pathToFileURL(path.join(__dirname, "..", "..", "src", "registry.js")).href);
const { createServer } = await import(pathToFileURL(path.join(__dirname, "..", "..", "src", "server.js")).href);

// Bind a real listener on a specific high port so the reservation shows up as a LISTENING (managed)
// port in the ecosystem view — this drives extension.js's _portRow() + status-bar managedCount().
// Retry a few ports in case one is taken on the test machine.
async function bindFreeHighPort(candidates) {
  for (const port of candidates) {
    const srv = net.createServer();
    const bound = await new Promise((resolve) => {
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) return { srv, port };
    try { srv.close(); } catch { /* ignore */ }
  }
  return null;
}

const RESERVED_PROJECT = "vscode-smoke";
const held = await bindFreeHighPort([54731, 54732, 54733, 54801, 54917, 55021]);
if (!held) { console.error("could not bind a test port"); process.exit(1); }
const RESERVED_PORT = held.port;

// adopt:true registers a port we ALREADY listen on (skips the free check). This makes the ecosystem
// classify it as "managed" (reserved AND listening).
await reserve({ project: RESERVED_PROJECT, owner: "vscode", port: RESERVED_PORT, adopt: true, purpose: "smoke dev server" });

// Also reserve a port we are NOT listening on, so it surfaces as a "ghost" reservation — this drives
// extension.js's _ghostRow().
const GHOST_PROJECT = "vscode-smoke-ghost";
const GHOST_PORT = await (async () => {
  const made = await reserve({ project: GHOST_PROJECT, owner: "vscode", rangeStart: 54950, rangeEnd: 54999 });
  return made[0].port;
})();

const server = createServer();
const serverUrl = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve(`http://127.0.0.1:${port}`);
  });
});

// ---------------------------------------------------------------------------------------------
// 2) Mock the 'vscode' module. Implement ONLY the APIs extension.js actually uses.
// ---------------------------------------------------------------------------------------------

// A minimal-but-real EventEmitter so onDidChangeTreeData works (event registers listeners; fire()
// invokes them) — extension.js relies on .event and .fire().
class FakeEventEmitter {
  constructor() { this._listeners = []; this.event = (listener) => { this._listeners.push(listener); return { dispose: () => {} }; }; }
  fire(arg) { for (const l of this._listeners.slice()) { try { l(arg); } catch { /* ignore */ } } }
  dispose() { this._listeners = []; }
}

class FakeTreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}
class FakeThemeIcon { constructor(id) { this.id = id; } }
class FakeUri {
  constructor(value) { this.value = value; this.toString = () => value; }
  static parse(value) { return new FakeUri(value); }
}

// Capture side effects so assertions can inspect them.
const captured = {
  treeProviders: new Map(),   // viewId -> provider
  commands: new Map(),        // id -> handler
  statusBars: [],             // created status bar items
  terminals: [],              // created terminals
  externalOpens: [],          // URIs passed to env.openExternal
  info: [], warn: [], error: [], // shown messages
  inputBoxQueue: [],          // queued showInputBox responses (shift per call)
};

function makeStatusBarItem() {
  const item = {
    text: undefined, tooltip: undefined, command: undefined, alignment: undefined, priority: undefined,
    _shown: false, _disposed: false,
    show() { this._shown = true; }, hide() { this._shown = false; }, dispose() { this._disposed = true; },
  };
  captured.statusBars.push(item);
  return item;
}

function makeTerminal(name) {
  const term = { name, _shown: false, _sent: [], show() { this._shown = true; }, sendText(t) { this._sent.push(t); }, dispose() {} };
  captured.terminals.push(term);
  return term;
}

const vscodeMock = {
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: FakeThemeIcon,
  EventEmitter: FakeEventEmitter,
  Uri: FakeUri,
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: {
    workspaceFolders: [{ name: "my-workspace", uri: FakeUri.parse("file:///tmp/my-workspace"), index: 0 }],
    getConfiguration(section) {
      return {
        get: (key) => {
          // extension.js reads "serverUrl" via getConfiguration("portbook").get("serverUrl").
          if (section === "portbook" && key === "serverUrl") return serverUrl;
          if (key.endsWith("serverUrl")) return serverUrl;
          return undefined;
        },
      };
    },
  },
  window: {
    registerTreeDataProvider(viewId, provider) { captured.treeProviders.set(viewId, provider); return { dispose() {} }; },
    createTreeView(viewId, opts) { if (opts && opts.treeDataProvider) captured.treeProviders.set(viewId, opts.treeDataProvider); return { dispose() {} }; },
    createStatusBarItem(alignment, priority) { const i = makeStatusBarItem(); i.alignment = alignment; i.priority = priority; return i; },
    createTerminal(name) { return makeTerminal(name); },
    async showInputBox(_opts) { return captured.inputBoxQueue.length ? captured.inputBoxQueue.shift() : undefined; },
    showInformationMessage(msg) { captured.info.push(msg); return Promise.resolve(undefined); },
    showWarningMessage(msg) { captured.warn.push(msg); return Promise.resolve(undefined); },
    showErrorMessage(msg) { captured.error.push(msg); return Promise.resolve(undefined); },
  },
  commands: {
    registerCommand(id, handler) { captured.commands.set(id, handler); return { dispose() {} }; },
    async executeCommand(id, ...args) { const h = captured.commands.get(id); return h ? h(...args) : undefined; },
  },
  env: {
    async openExternal(uri) { captured.externalOpens.push(uri); return true; },
  },
};

// Intercept require('vscode') by overriding Module._load: return our mock for 'vscode', otherwise
// defer to the real loader. This is what lets the unmodified CommonJS extension.js load here.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------------------------
// 3) Load the REAL extension.js (CJS) AFTER the mock is installed, and activate it.
// ---------------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const extension = require(path.join(__dirname, "extension.js"));
ok("extension exports activate()", typeof extension.activate === "function");
ok("extension exports deactivate()", typeof extension.deactivate === "function");

const context = { subscriptions: [] };
extension.activate(context);

ok("activate registered the tree data provider", captured.treeProviders.has("portbookPorts"));
ok("activate registered the refresh/openDashboard/reserve/serve commands",
  ["portbook.refresh", "portbook.openDashboard", "portbook.reserve", "portbook.serve"].every((c) => captured.commands.has(c)));
ok("activate created a status bar item", captured.statusBars.length >= 1);
ok("activate pushed disposables into context.subscriptions", context.subscriptions.length >= 1);

const provider = captured.treeProviders.get("portbookPorts");
const statusBar = captured.statusBars[0];

// activate() calls provider.refresh() + getChildren() at the end, but those are async and we don't
// hold their promise. Call getChildren() ourselves and await it to get a deterministic snapshot.
const rootItems = await provider.getChildren();

ok("getChildren() returns at least one row", Array.isArray(rootItems) && rootItems.length >= 1);

// The reserved+listening port should appear as a managed row: label is the port number, and the
// description carries the kind + reserving project.
const managedRow = rootItems.find((it) => String(it.label) === String(RESERVED_PORT));
ok("a row reflects the reserved (managed) port by label", !!managedRow);
ok("the managed row's description names its project + managed kind",
  !!managedRow && typeof managedRow.description === "string" &&
  managedRow.description.includes(RESERVED_PROJECT) && managedRow.description.includes("managed"));
ok("the managed row carries the managed contextValue", !!managedRow && managedRow.contextValue === "portbookPort");

// The ghost reservation should appear as a ghost row too.
const ghostRow = rootItems.find((it) => String(it.label) === String(GHOST_PORT));
ok("a row reflects the ghost reservation by label", !!ghostRow);
ok("the ghost row is described as a ghost reservation for its project",
  !!ghostRow && typeof ghostRow.description === "string" &&
  ghostRow.description.includes("ghost") && ghostRow.description.includes(GHOST_PROJECT));
ok("the ghost row carries the ghost contextValue", !!ghostRow && ghostRow.contextValue === "portbookGhost");

// getTreeItem is identity in this provider; make sure it round-trips an item.
ok("getTreeItem returns the item it is given", provider.getTreeItem(managedRow) === managedRow);

// Status bar should reflect the live managed count (>=1 because we adopted a listening port). The
// provider fires its onRefresh callback after each fetch settles, which repaints the status bar.
ok("status bar text shows the plug glyph + 'reserved'",
  typeof statusBar.text === "string" && statusBar.text.includes("$(plug)") && statusBar.text.includes("reserved"));
ok("status bar reflects a managed count of at least 1",
  /\$\(plug\)\s+([1-9]\d*)\s+reserved/.test(statusBar.text || ""));
ok("status bar was shown", statusBar._shown === true);
ok("status bar click target is the dashboard command", statusBar.command === "portbook.openDashboard");

// ---------------------------------------------------------------------------------------------
// 4) Drive the commands.
// ---------------------------------------------------------------------------------------------

// refresh: invoking it should not throw and the view should still render the reserved port.
await captured.commands.get("portbook.refresh")();
const afterRefresh = await provider.getChildren();
ok("after refresh, the reserved port is still present",
  afterRefresh.some((it) => String(it.label) === String(RESERVED_PORT)));

// openDashboard: should call env.openExternal with the configured server URL.
const opensBefore = captured.externalOpens.length;
await captured.commands.get("portbook.openDashboard")();
ok("openDashboard opened the server URL externally",
  captured.externalOpens.length === opensBefore + 1 &&
  String(captured.externalOpens[captured.externalOpens.length - 1].toString()).startsWith(serverUrl));

// reserve (cancelled): showInputBox returns undefined -> handler returns early, no reservation made,
// no info/error message shown.
const infoBefore = captured.info.length, errBefore = captured.error.length;
captured.inputBoxQueue = []; // ensures showInputBox resolves undefined (user cancelled)
await captured.commands.get("portbook.reserve")();
ok("reserve cancelled (no input) is a no-op — no info/error message",
  captured.info.length === infoBefore && captured.error.length === errBefore);

// reserve (happy path): queue a purpose; the handler POSTs /api/reserve to the real server and should
// report success with a granted port for the workspace project ("my-workspace").
captured.inputBoxQueue = ["vite dev server"];
await captured.commands.get("portbook.reserve")();
ok("reserve (with purpose) reported a granted port via showInformationMessage",
  captured.info.some((m) => /reserved port \d+/.test(m) && m.includes("my-workspace")));
ok("reserve did not surface an error", captured.error.length === errBefore);

// After a real reserve, the new port should show up on the next fetch.
const afterReserve = await provider.getChildren();
const grantMatch = (captured.info.find((m) => /reserved port \d+/.test(m)) || "").match(/reserved port (\d+)/);
const grantedPort = grantMatch ? grantMatch[1] : null;
ok("the newly reserved port appears in the tree",
  !!grantedPort && afterReserve.some((it) => String(it.label) === String(grantedPort)));

// serve: should create a terminal named "portbook serve" and send the serve command. (We don't let
// the spawned 1.5s refresh timer matter — it just calls getChildren again against our live server.)
await captured.commands.get("portbook.serve")();
ok("serve created an integrated terminal that runs `portbook serve`",
  captured.terminals.some((t) => t.name === "portbook serve" && t._sent.some((s) => s.includes("portbook serve"))));

// ---------------------------------------------------------------------------------------------
// 5) Server-down degradation: point the extension at a dead URL and confirm the one-click affordance.
// ---------------------------------------------------------------------------------------------
{
  // Temporarily make getConfiguration return an unreachable URL.
  const goodUrl = serverUrl;
  const deadUrl = "http://127.0.0.1:1"; // nothing listens here
  vscodeMock.workspace.getConfiguration = (section) => ({
    get: (key) => (key.endsWith("serverUrl") ? deadUrl : undefined),
  });
  const downItems = await provider.getChildren();
  ok("server-down yields exactly one affordance row",
    Array.isArray(downItems) && downItems.length === 1);
  ok("server-down row offers to start the server (click -> portbook.serve)",
    downItems[0] && downItems[0].command && downItems[0].command.command === "portbook.serve");
  ok("status bar shows '?' when the server is unreachable",
    typeof statusBar.text === "string" && statusBar.text.includes("?"));
  // restore
  vscodeMock.workspace.getConfiguration = (section) => ({
    get: (key) => (section === "portbook" && key === "serverUrl") || key.endsWith("serverUrl") ? goodUrl : undefined,
  });
}

// deactivate(): should dispose the status bar without throwing.
extension.deactivate();
ok("deactivate disposed the status bar", statusBar._disposed === true);

// ---------------------------------------------------------------------------------------------
// 6) Cleanup.
// ---------------------------------------------------------------------------------------------
Module._load = origLoad;
await new Promise((r) => server.close(r));
try { held.srv.close(); } catch { /* ignore */ }
try { fs.rmSync(process.env.PORTBOOK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
