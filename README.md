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

## What you get

- **One reliable presentation mode.** Hunk takes over the terminal at full size; no embedded, side,
  floating, or multiplexer-specific renderer.
- **Inline feedback.** Saved Hunk comments return to the agent as soon as the Hunk process exits.
- **Optional automatic reviews.** Open after a change or watch edits live when you opt in.
- **Multiple repositories.** Review each repository touched in the same agent run.
- **Your VCS, your Hunk setup.** Git, Jujutsu, and Sapling work through Hunk's normal configuration.

> Pi-hunk only reads saved Hunk comments. It never edits, resolves, applies, or deletes them.

## Install

Requirements:

- [Pi](https://github.com/earendil-works/pi) 0.80+ or
  [Oh My Pi](https://github.com/can1357/oh-my-pi) 17.3.4+
- [Hunk](https://github.com/modem-dev/hunk) 0.18.2+ on `PATH`
- Node.js 22.19+
- macOS arm64, or glibc Linux x64/arm64

Stable 1.x (`latest`, recommended):

```bash
# Pi
pi install npm:pi-hunk@latest

# Oh My Pi
omp install pi-hunk@latest
```

Canary is a rolling build from `main`, independent of the stable Changesets plan, and may regress:

```bash
# Pi
pi install npm:pi-hunk@canary

# Oh My Pi
omp install pi-hunk@canary
```

Both streams use the same package; npm tags select the stream. Then run `/reload` in the active
host.

A managed `pi update --extensions` replaces its configured npm source in place. If Pi reports a
duplicate `/hunk` command, run `pi list`: another local, project, or CLI extension source is also
configured. Remove that source, keep the intended `npm:pi-hunk` source, then run `/reload`.

## Quick start

1. Ask Pi or OMP to change some code.
2. Press <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> to open Hunk.
3. Review the diff and save inline comments with Hunk.
4. Quit Hunk with <kbd>q</kbd>. Pi resumes and receives the saved comments.

Automatic opening is off by default. Run `/hunk review after-run` to open Hunk after successful
changes, or `/hunk review live` to open on the first change attempt and follow edits. If feedback
delivery cannot be confirmed after Hunk exits, run `/hunk feedback`; captured notes remain
recoverable for the current Pi session.

## Full-screen takeover

Pi-hunk supports one lifecycle:

1. Pi stops its TUI.
2. Hunk inherits the physical terminal's stdin, stdout, resize events, and terminal modes.
3. Hunk exits.
4. Pi restarts its TUI, repaints, and submits captured review notes.

There is no hide or restore operation. Quitting Hunk ends that review process; reopening starts a
new Hunk session. This removes the native PTY and terminal-emulation layer that earlier releases
used.

## Shortcuts

Shortcuts apply while Pi owns the terminal:

| Shortcut                                            | Action                          |
| --------------------------------------------------- | ------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> | Open the configured Hunk review |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>S</kbd> | Open `hunk show`                |

Change the prefix or either action key from `/hunk config` by pressing the desired key.

## Choose when Hunk opens

| Policy      | Behavior                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `off`       | Never open automatically; commands and shortcuts still work. **Default.** |
| `after-run` | Open after the agent successfully changes code.                           |
| `live`      | Open on the first change attempt and follow successful edits.             |

```text
/hunk review live
```

Automatic review is triggered by the host's coding tools, not by conversation or read-only work.

## Commands

| Command                             | Action                                      |
| ----------------------------------- | ------------------------------------------- |
| `/hunk`                             | Open the watched working-copy review        |
| `/hunk <target>`                    | Review a ref or revset                      |
| `/hunk show [target]`               | Review the latest or selected revision      |
| `/hunk staged`                      | Review Git staged changes                   |
| `/hunk stash show [ref]`            | Review a Git stash                          |
| `/hunk feedback`                    | Retry delivery of captured comments         |
| `/hunk next`                        | Open the next queued repository             |
| `/hunk status`                      | Show policy, process state, and diagnostics |
| `/hunk close`                       | Terminate the managed Hunk process          |
| `/hunk review off\|after-run\|live` | Change the automatic-review policy          |
| `/hunk config`                      | Open global settings                        |
| `/hunk config restore`              | Remove global overrides                     |

## Configure

Run `/hunk config` to change the review policy, follow-edits behavior, and shortcuts. Changes save
in Pi's global agent directory (`~/.pi/agent/hunk.json` by default). `PI_CODING_AGENT_DIR` and
`PI_HUNK_CONFIG` are respected. Project-local `.pi/hunk.json` files are ignored; trusted projects
receive a migration warning.

The configuration schema is intentionally small:

```json
{
  "review": "off",
  "followEdits": true,
  "hunk": {
    "command": "hunk",
    "args": ["diff", "--watch"]
  },
  "bindings": {
    "prefix": "ctrl+space",
    "open": "h",
    "show": "s"
  }
}
```

`hunk.args` must not contain `--no-extensions`: pi-hunk loads a bundled Hunk extension that captures
saved user notes before the process exits. Themes, presentation, and Hunk keybindings stay in Hunk's
own [`config.toml`](https://github.com/modem-dev/hunk#configuration).

`PI_HUNK_REVIEW` can override the saved review policy. Pi-hunk warns when that happens.

## Multiple repositories

Pi-hunk opens the repository containing the files Pi changed. If one run changes more than one
repository, quit the current Hunk review and use `/hunk next` to open the next queued review.

This works with Git, Jujutsu, and Sapling; Hunk chooses the backend using its normal settings.

## Support

When reporting a terminal issue, include your platform, terminal, Pi version, Hunk version, and VCS.

- [Report a bug](https://github.com/igshehata/pi-hunk/issues/new?template=bug.yml)
- [Request a feature](https://github.com/igshehata/pi-hunk/issues/new?template=feature.yml)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
