// portbook — VS Code extension (also runs in Cursor & Windsurf, which are VS Code forks).
//
// Thin and buildless: plain CommonJS, `require('vscode')` only, and global `fetch` (Node 18+, which
// every supported editor ships) for HTTP. All state comes from a running `portbook serve` HTTP server
// at the `portbook.serverUrl` setting — we never import the portbook core. If the server is down we
// degrade gracefully: the tree shows a one-click "Start portbook serve" affordance instead of erroring.
"use strict";
const vscode = require("vscode");

// --- config + HTTP helpers ---------------------------------------------------------------------

// Read the server base URL fresh each call (so settings changes take effect without a reload) and
// strip any trailing slash so we can append "/api/..." cleanly.
function serverUrl() {
  const raw = vscode.workspace.getConfiguration("portbook").get("serverUrl") || "http://127.0.0.1:7800";
  return String(raw).replace(/\/+$/, "");
}

// GET/POST JSON against the portbook server with a short timeout. Throws on network failure or a
// non-2xx response so callers can distinguish "server down" from a normal empty result.
async function api(pathname, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(serverUrl() + pathname, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The active workspace folder's name — used as the default project when reserving. Falls back to a
// generic label so reserve still works in a window with no folder open.
function workspaceProject() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].name : "vscode-workspace";
}

// --- tree data ---------------------------------------------------------------------------------

// One row in the Ports view. A `port` item maps an ecosystem port/ghost; a `message` item is a
// plain informational line (e.g. "server is not running") with an optional command to run on click.
class PortItem extends vscode.TreeItem {
  constructor(label, opts = {}) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (opts.description) this.description = opts.description;
    if (opts.tooltip) this.tooltip = opts.tooltip;
    if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon);
    if (opts.command) this.command = opts.command;
    if (opts.context) this.contextValue = opts.context;
  }
}

// Per-kind icon (codicon ids) so the tree reads at a glance.
const KIND_ICON = {
  managed: "pass-filled",
  container: "package",
  unmanaged: "question",
  ghost: "circle-slash",
};

class PortsProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.eco = null;     // last successful /api/ecosystem payload
    this.error = null;   // last fetch error message, if the server is unreachable
    this.onRefresh = null; // optional callback fired AFTER each fetch settles (keeps the status bar in sync)
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren() {
    // Re-fetch on every expansion/refresh so the view reflects live OS + registry state.
    try {
      this.eco = await api("/api/ecosystem");
      this.error = null;
    } catch (e) {
      this.eco = null;
      this.error = e && e.message ? e.message : String(e);
    }
    // Notify AFTER eco/error are updated. The onDidChangeTreeData event fires BEFORE this fetch runs,
    // so a status-bar listener on it would read last cycle's data — call back here instead.
    if (this.onRefresh) { try { this.onRefresh(); } catch { /* status update is best-effort */ } }

    if (this.error) {
      return [
        new PortItem("portbook server is not running", {
          description: "click to start",
          tooltip: `Could not reach ${serverUrl()}\n${this.error}\n\nClick to run \`portbook serve\` in a terminal.`,
          icon: "debug-disconnect",
          command: { command: "portbook.serve", title: "Start portbook serve" },
        }),
      ];
    }

    const eco = this.eco || {};
    const ports = Array.isArray(eco.ports) ? eco.ports : [];
    const ghosts = Array.isArray(eco.ghosts) ? eco.ghosts : [];
    if (!ports.length && !ghosts.length) {
      return [new PortItem("no host ports detected", { icon: "info" })];
    }

    const items = ports.map((p) => this._portRow(p));
    // Ghost reservations have nothing listening; surface them too so stale holds are visible.
    for (const g of ghosts) items.push(this._ghostRow(g));
    return items;
  }

  // Build a row for a listening host port: "port + kind + what + reservation project".
  _portRow(p) {
    const kind = p.kind || "unmanaged";
    const what = p.container ? p.container.name : p.proc || "(unknown)";
    const project = p.reservation ? p.reservation.project : null;
    // Description is the compact right-hand summary; tooltip carries the full detail.
    const desc = [kind, what, project ? `→ ${project}` : ""].filter(Boolean).join("  ");
    const tip = [
      `port ${p.port}  (${kind})`,
      p.container ? `container: ${p.container.name} (${p.container.image})` : null,
      p.proc ? `process: ${p.proc}${p.pid ? ` [pid ${p.pid}]` : ""}` : null,
      project ? `reserved by: ${project}${p.reservation.purpose ? ` — ${p.reservation.purpose}` : ""}` : null,
    ].filter(Boolean).join("\n");
    return new PortItem(String(p.port), {
      description: desc,
      tooltip: tip,
      icon: KIND_ICON[kind] || "circle-outline",
      context: "portbookPort",
    });
  }

  // Build a row for a ghost reservation (reserved, but nothing is listening).
  _ghostRow(g) {
    return new PortItem(String(g.port), {
      description: `ghost  reserved → ${g.project}`,
      tooltip: `port ${g.port}  (ghost — reserved but nothing is listening)\nreserved by: ${g.project}${g.purpose ? ` — ${g.purpose}` : ""}`,
      icon: KIND_ICON.ghost,
      context: "portbookGhost",
    });
  }

  // Count of managed (reserved AND listening) host ports, for the status bar.
  managedCount() {
    if (this.eco && this.eco.summary && typeof this.eco.summary.managed === "number") return this.eco.summary.managed;
    if (this.eco && Array.isArray(this.eco.ports)) return this.eco.ports.filter((p) => p.kind === "managed").length;
    return 0;
  }
}

// --- activation --------------------------------------------------------------------------------

let statusBar; // module-scoped so deactivate() can dispose it deterministically.

function activate(context) {
  const provider = new PortsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("portbookPorts", provider)
  );

  // Status bar: "$(plug) N reserved" — clicking opens the dashboard.
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "portbook.openDashboard";
  statusBar.tooltip = "portbook — reserved (managed) ports on this machine. Click to open the dashboard.";
  context.subscriptions.push(statusBar);

  const updateStatus = () => {
    if (!statusBar) return; // a late refresh timer can fire after deactivate() disposed us
    const n = provider.error ? "?" : provider.managedCount();
    statusBar.text = `$(plug) ${n} reserved`;
    statusBar.show();
  };
  // Whenever the tree refetches, the status count may change — keep them in lockstep. The provider
  // calls this AFTER each fetch settles (onDidChangeTreeData fires before the fetch, so it would be
  // a cycle stale). Paint once up front so the bar appears immediately, before the first fetch lands.
  provider.onRefresh = updateStatus;
  updateStatus();

  // refresh — re-pull ecosystem + repaint tree and status bar.
  context.subscriptions.push(
    vscode.commands.registerCommand("portbook.refresh", () => provider.refresh())
  );

  // openDashboard — open the server's web dashboard in the external browser.
  context.subscriptions.push(
    vscode.commands.registerCommand("portbook.openDashboard", () =>
      vscode.env.openExternal(vscode.Uri.parse(serverUrl()))
    )
  );

  // reserve — prompt for a purpose, POST /api/reserve, report the granted port.
  context.subscriptions.push(
    vscode.commands.registerCommand("portbook.reserve", async () => {
      const purpose = await vscode.window.showInputBox({
        title: "portbook: reserve a port",
        prompt: "What is this port for? (purpose)",
        placeHolder: "e.g. dev server, api, vite",
      });
      if (purpose === undefined) return; // user cancelled
      const project = workspaceProject();
      try {
        const made = await api("/api/reserve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project, owner: "vscode", count: 1, purpose: purpose || null }),
        });
        const ports = Array.isArray(made) ? made.map((m) => m.port) : [];
        if (ports.length) {
          vscode.window.showInformationMessage(`portbook: reserved port ${ports.join(", ")} for "${project}".`);
          provider.refresh();
        } else {
          vscode.window.showWarningMessage("portbook: reserve returned no ports.");
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `portbook: reserve failed (${e && e.message ? e.message : e}). Is the server running? Try "portbook: Start Server".`
        );
      }
    })
  );

  // serve — run `portbook serve` in an integrated terminal (the graceful-degradation path).
  context.subscriptions.push(
    vscode.commands.registerCommand("portbook.serve", () => {
      const term = vscode.window.createTerminal("portbook serve");
      term.show();
      term.sendText("portbook serve");
      // Give the server a moment to bind, then refresh so the view fills in without manual action.
      setTimeout(() => provider.refresh(), 1500);
    })
  );

  // Initial paint. Repaint the tree (if the view is open) AND proactively fetch once so the status
  // bar populates even when the Ports view is collapsed and VS Code hasn't called getChildren() yet.
  provider.refresh();
  provider.getChildren();
}

function deactivate() {
  if (statusBar) {
    statusBar.dispose();
    statusBar = undefined;
  }
}

module.exports = { activate, deactivate };
