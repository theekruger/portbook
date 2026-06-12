# portbook — VS Code extension

A thin, buildless extension that surfaces the [portbook](../../README.md) port registry inside your
editor: see every host port (managed / container / unmanaged / ghost), watch how many are reserved
from the status bar, reserve a new port for the current workspace, and jump to the web dashboard.

Works identically in **VS Code**, **Cursor**, and **Windsurf** (both are VS Code forks — same
extension host, same API).

## What it does

- **Ports view** (activity bar → the `$(plug)` icon): lists host ports from the portbook server,
  each row showing the port number, its kind (managed / container / unmanaged / ghost), the owning
  container or process, and the reserving project. Ghost reservations (reserved but nothing
  listening) are shown too.
- **Status bar**: `$(plug) N reserved` — the count of *managed* ports (reserved **and** listening).
  Click it to open the dashboard.
- **Commands** (Command Palette → "portbook:"):
  - **Refresh Ports** — re-pull the ecosystem and repaint.
  - **Open Dashboard** — open the server's web UI in your browser.
  - **Reserve a Port** — prompts for a purpose, then reserves one port for the current workspace
    folder (`owner: "vscode"`) and tells you which port you got.
  - **Start Server (`portbook serve`)** — runs `portbook serve` in an integrated terminal. This is
    also offered automatically (one click) when the view can't reach the server.

The extension is a thin client: it talks **only** to the portbook HTTP server over `fetch` and never
imports the portbook core. If the server is down, the view shows a one-click "start the server"
affordance instead of an error.

## Requirements

- A running portbook server. Start it from a terminal with `portbook serve`, or use the
  **portbook: Start Server** command. (The extension can launch it for you.)
- An editor with the VS Code API `^1.75.0` and Node 18+ in its extension host (VS Code 1.75+,
  current Cursor, current Windsurf — all fine; `fetch` is built in).

## Install

### From the Marketplace (recommended)

The extension is published as
[`portbook.portbook`](https://marketplace.visualstudio.com/items?itemName=portbook.portbook):
search **"portbook"** in the Extensions view, or run `ext install portbook.portbook` from the
Command Palette, or:

```bash
code --install-extension portbook.portbook
```

(Cursor and Windsurf users: install from the bundled `.vsix` below or via Open VSX when available —
their extension views use a different registry.)

### Run from source (no build step)

1. Open **this folder** (`integrations/vscode`) in VS Code / Cursor / Windsurf.
2. Press **F5** to launch an Extension Development Host with portbook loaded.

### Package and install a `.vsix`

```sh
npm install -g @vscode/vsce   # or: npx @vscode/vsce ...
cd integrations/vscode
vsce package                  # produces portbook-0.1.0.vsix
```

Then install the `.vsix`:

- **VS Code / Cursor / Windsurf**: Extensions view → `…` menu → **Install from VSIX…**, pick the file.
- Or from a terminal: `code --install-extension portbook-0.1.0.vsix`
  (Cursor: `cursor --install-extension …`; Windsurf: `windsurf --install-extension …`).

> Packaging may warn about a missing repository field or LICENSE — those are non-fatal for local
> installs. There are **no runtime dependencies** to install.

## Configure

One setting controls everything:

| Setting              | Default                   | Description                                   |
| -------------------- | ------------------------- | --------------------------------------------- |
| `portbook.serverUrl` | `http://127.0.0.1:7800`   | Base URL of the running `portbook serve` HTTP server. |

Set it under **Settings → Extensions → portbook**, or in `settings.json`:

```json
{
  "portbook.serverUrl": "http://127.0.0.1:7800"
}
```

Point it at a shared "fleet" server (e.g. a tailnet IP that `portbook serve --bind` is listening on)
to view ports across machines. The setting is read fresh on every request, so changes take effect
without reloading the window.

## Cursor & Windsurf

Nothing changes. Both are VS Code forks and run this extension as-is — open the folder and press F5,
or install the same `.vsix` with their CLI (`cursor`/`windsurf`) or the "Install from VSIX…" menu.
