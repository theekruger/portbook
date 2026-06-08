# portbook for JetBrains IDEs

Run portbook from inside IntelliJ IDEA, PyCharm, WebStorm, GoLand, RubyMine, CLion, Rider, etc. — no
plugin required. This integration ships a ready-made **External Tools** set ([`external-tools.xml`](./external-tools.xml))
that adds portbook commands to the **Tools** menu, the right-click menu, and (optionally) a keyboard
shortcut. CLI only, zero dependencies — it just shells out to the `portbook` already on your PATH.

## Prerequisite

`portbook` must be on your PATH so the IDE can launch it:

```bash
git clone <repo> portbook && cd portbook
npm link        # puts `portbook` on PATH (Node >= 18, no dependencies)
portbook where  # sanity check: prints the registry file path
```

> If the IDE was already running when you ran `npm link`, restart it (or your login shell) so it
> picks up the updated PATH. On Windows, confirm with `where.exe portbook`; on macOS/Linux, `which portbook`.

## Tools included

| Tool (Tools menu)              | Runs                                                        | What it does |
|--------------------------------|------------------------------------------------------------|--------------|
| portbook: list                 | `portbook list`                                            | Reserved ports + live BOUND state for this machine |
| portbook: list (this project)  | `portbook list --project $ProjectName$`                    | Same, filtered to the open project |
| portbook: scan                 | `portbook scan`                                            | Everything ACTUALLY listening; flags unmanaged ports |
| portbook: env (ecosystem)      | `portbook env`                                            | Full ecosystem: host ports + containers + WSL |
| portbook: reserve for project  | `portbook reserve --project $ProjectName$ --count 1 --owner jetbrains` | Grab one free port for the open project |
| portbook: serve (dashboard)    | `portbook serve --open`                                   | Start the live web dashboard and open it in a browser |

`$ProjectName$` and `$ProjectFileDir$` are JetBrains [path macros](https://www.jetbrains.com/help/idea/built-in-macros.html)
the IDE expands at launch: the project name becomes the portbook reservation key, and the project
directory becomes the command's working directory. Output appears in the IDE's Run console.

## Install — import the XML

JetBrains reads External Tools from a per-IDE config directory named `tools/`. Each `*.xml` file there
becomes a tool group whose `<toolSet name="...">` must match the file name. **Copy
`external-tools.xml` to that directory, renaming it to `portbook.xml`**, then restart the IDE.

Config-directory locations (replace `<IDE>` with the versioned product folder, e.g.
`IntelliJIdea2024.1`, `PyCharm2024.1`, `WebStorm2024.1`):

- **macOS:** `~/Library/Application Support/JetBrains/<IDE>/tools/`
- **Windows:** `%APPDATA%\JetBrains\<IDE>\tools\`
- **Linux:** `~/.config/JetBrains/<IDE>/tools/`

```bash
# macOS / Linux example (PyCharm 2024.1 — adjust the folder for your IDE):
# Note: keep ~ OUTSIDE the quotes so the shell expands it to your home dir.
mkdir -p ~/"Library/Application Support/JetBrains/PyCharm2024.1/tools"
cp external-tools.xml ~/"Library/Application Support/JetBrains/PyCharm2024.1/tools/portbook.xml"
```

```powershell
# Windows example (IntelliJ IDEA 2024.1 — adjust the folder for your IDE):
New-Item -ItemType Directory -Force "$env:APPDATA\JetBrains\IntelliJIdea2024.1\tools" | Out-Null
Copy-Item .\external-tools.xml "$env:APPDATA\JetBrains\IntelliJIdea2024.1\tools\portbook.xml"
```

Not sure which folder? In the IDE, **Help > Show Log in Explorer/Finder** opens the log directory;
the config root (with `tools/` beside `options/`, `keymaps/`, etc.) is its sibling.

After restarting, the commands appear under **Tools > portbook** and in **Settings/Preferences >
Tools > External Tools**.

### Or recreate the entries by hand

Prefer not to touch the config folder? Add each tool through the UI:

1. **Settings/Preferences > Tools > External Tools > +** (Add).
2. Fill in:
   - **Name:** e.g. `portbook: reserve for project` — **Group:** `portbook` (so they nest together).
   - **Program:** `portbook`
   - **Arguments:** the command, e.g. `reserve --project $ProjectName$ --count 1 --owner jetbrains`
   - **Working directory:** `$ProjectFileDir$`  (click **Insert Macro…** to pick macros from a list).
3. Repeat for `list`, `scan`, `env`, and `serve --open`. Use the table above for the exact arguments.

## Bind to a keymap (shortcut)

1. **Settings/Preferences > Keymap**.
2. Expand **External Tools > portbook** and select a tool (e.g. *portbook: reserve for project*).
3. Right-click it > **Add Keyboard Shortcut**, press your combo (e.g. `Ctrl+Alt+P` /
   `Cmd+Alt+P`), and resolve any conflict the IDE flags.

You can also trigger any tool without a shortcut via **Find Action** (`Ctrl+Shift+A` / `Cmd+Shift+A`)
and typing the tool name.

## Roadmap: a thin native plugin

External Tools cover the everyday flow today. A future lightweight JetBrains plugin could poll the
HTTP API exposed by `portbook serve` — `GET /api/ecosystem` (and `/api/scan`, `/api/list?project=`) —
and render the live picture in a dedicated tool window: which ports the open project holds, what's
BOUND right now, and one-click **reserve/release** via `POST /api/reserve` and `POST /api/release`.
The CLI-backed External Tools here are the zero-dependency baseline that plugin would build on.
