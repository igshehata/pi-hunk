<div align="center">

# pi-hunk

**Review Pi or Oh My Pi changes in a full-screen Hunk takeover.**

Launch Hunk from the agent, annotate the diff, then return saved comments to the agent when Hunk
exits.

[![CI](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml/badge.svg)](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-hunk?logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-hunk)
[![Node](https://img.shields.io/node/v/pi-hunk?logo=nodedotjs&color=339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6.svg)](LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Configure](#configure)

</div>

## What pi-hunk does

- Gives Hunk the physical terminal at full size. No overlay, embedded renderer, PTY proxy, or hidden
  session.
- Supports Pi and Oh My Pi through the same extension entry point and behavior.
- Opens Hunk manually in `diff`, `show`, or `stash` mode.
- Returns the final authoritative set of saved user notes after Hunk exits. A failed snapshot is
  reported and never replaced with stale event data.
- Leaves themes, navigation, VCS detection, and all other review behavior to Hunk.

Pi-hunk does not open automatically, route across repositories, or modify Hunk comments.

## Install

Requirements:

- [Pi](https://github.com/earendil-works/pi) 0.80+ or
  [Oh My Pi](https://github.com/can1357/oh-my-pi) 17.3.4+
- [Hunk](https://github.com/modem-dev/hunk) 0.20.1+ on `PATH` (extension API 8+)
- Node.js 22.19+
- macOS arm64, or glibc Linux x64/arm64

Stable 1.x:

```bash
# Pi
pi install npm:pi-hunk@latest

# Oh My Pi
omp install pi-hunk@latest
```

Rolling canary from `main`:

```bash
# Pi
pi install npm:pi-hunk@canary

# Oh My Pi
omp install pi-hunk@canary
```

Reload host plugins after installation or update: `/reload` in Pi, `/reload-plugins` in OMP. If Pi
reports a duplicate `/hunk` command, use `pi list` and remove the unintended local, project, or npm
extension source.

## Quick start

1. Ask Pi or OMP to change code.
2. Press <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> to open `hunk diff HEAD --watch`.
3. Save inline comments in Hunk.
4. Quit Hunk with <kbd>Q</kbd>. The host resumes and receives the final saved comments.

## Full-screen takeover

Each launch has one lifecycle:

1. Pi-hunk allocates a private feedback path and stops the host TUI.
2. Hunk inherits the physical terminal's stdin, stdout, resize events, and terminal modes.
3. The bundled Hunk extension captures saved comments and the final authoritative review snapshot.
4. Hunk exits naturally or pi-hunk terminates it during host shutdown.
5. Pi-hunk restarts and repaints the host TUI, then submits captured comments.

Hunk must own the physical TTY directly. Pi-hunk intentionally has no stdin proxy, hide/restore
operation, background process, or alternate layout.

## Shortcuts

The default chord is available both while the host owns the terminal and while Hunk is open:

| Shortcut                                            | Action              |
| --------------------------------------------------- | ------------------- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> | Toggle `diff`       |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>S</kbd> | Toggle `show`       |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>T</kbd> | Toggle `stash show` |

From Hunk, choosing another mode exits the current child and opens the selected mode without
returning control to the host in between. Choosing the current mode exits Hunk.

## Commands

| Command                | Action                                       |
| ---------------------- | -------------------------------------------- |
| `/hunk`                | Open `hunk diff HEAD --watch`                |
| `/hunk diff [target]`  | Open a watched diff; target defaults to HEAD |
| `/hunk show [target]`  | Show a revision; target defaults to HEAD     |
| `/hunk stash [ref]`    | Show the latest or selected stash            |
| `/hunk config`         | Edit global hotkeys interactively            |
| `/hunk config restore` | Remove global overrides                      |

`/hunk stash show [ref]` is also accepted to mirror Hunk's command shape. Other subcommands and
extra arguments are rejected with usage guidance.

## Configure

`/hunk config` changes only the prefix and three action keys. It writes `~/.pi/agent/hunk.json` by
default. `PI_CODING_AGENT_DIR` changes the host agent directory; `PI_HUNK_CONFIG` can select an
isolated config path. Project-local config files are ignored.

```json
{
  "hotkeys": {
    "prefix": "ctrl+space",
    "diff": "h",
    "show": "s",
    "stash": "t"
  }
}
```

The prefix must be a safe modified key or function key and must not collide with an active host
binding. All four bindings must be distinct. Writes are owner-only, cross-process serialized, and
committed by same-directory atomic rename. Reload host plugins after changing bindings—`/reload` in
Pi or `/reload-plugins` in OMP—so the host can register the new prefix.

## Support

When reporting a terminal issue, include the platform, terminal, host version, Hunk version, launch
mode, and exact key sequence.

- [Report a bug](https://github.com/igshehata/pi-hunk/issues/new?template=bug.yml)
- [Request a feature](https://github.com/igshehata/pi-hunk/issues/new?template=feature.yml)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
