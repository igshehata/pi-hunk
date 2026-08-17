<div align="center">

# pi-hunk

**Review Pi or Oh My Pi changes in Hunk without leaving the agent.**

Annotate diffs, send comments back to the agent, and keep your review open while it continues
working.

[![CI](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml/badge.svg)](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-hunk?logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-hunk)
[![Node](https://img.shields.io/node/v/pi-hunk?logo=nodedotjs&color=339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6.svg)](LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Configure](#configure)

</div>

## What you get

- **Review inside Pi or OMP.** No tmux or external pane manager.
- **Optional automatic reviews.** Open after a change or watch edits live when you opt in.
- **Inline feedback.** Hide Hunk to send new comments back to the agent.
- **Persistent sessions.** Hide and restore Hunk without losing your place or comments.
- **Multiple repositories.** Review each repository touched in the same agent run.
- **Your VCS, your Hunk setup.** Git, Jujutsu, and Sapling work through Hunk's normal configuration.
- **Flexible layouts.** Use full screen, either side, or a floating window.

> Pi-hunk only reads Hunk comments. It never edits, resolves, applies, or deletes them.

## Install

Requirements:

- [Pi](https://github.com/earendil-works/pi) 0.80+ or
  [Oh My Pi](https://github.com/can1357/oh-my-pi) 17.3.4+
- [Hunk](https://github.com/modem-dev/hunk) 0.17.6+ on `PATH`
- Node.js 22.19+
- macOS arm64, or glibc Linux x64/arm64

Stable 0.3.x (`latest`, recommended):

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
3. Review the diff and leave inline comments.
4. Use the same shortcut to hide Hunk and send the comments back to the agent.

Automatic opening is off by default. Run `/hunk review after-run` to open Hunk after successful
changes, or `/hunk review live` to follow edits during a run. If feedback delivery cannot be
confirmed, run `/hunk feedback`; the notes remain recoverable.

## Shortcuts

| Shortcut                                            | Action                                 |
| --------------------------------------------------- | -------------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> | Open, hide, or restore the main review |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>S</kbd> | Open, hide, or restore `hunk show`     |

Change either shortcut from `/hunk config` by pressing the key you want.

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

| Command                             | Action                                     |
| ----------------------------------- | ------------------------------------------ |
| `/hunk`                             | Open the watched working-copy review       |
| `/hunk <target>`                    | Review a ref or revset                     |
| `/hunk show [target]`               | Review the latest or selected revision     |
| `/hunk staged`                      | Review Git staged changes                  |
| `/hunk stash show [ref]`            | Review a Git stash                         |
| `/hunk toggle`                      | Show or hide the current review            |
| `/hunk submit`                      | Check now for new comments                 |
| `/hunk feedback`                    | Retry comment collection and delivery      |
| `/hunk next`                        | Open the next queued repository            |
| `/hunk status`                      | Show policy, review state, and diagnostics |
| `/hunk close`                       | Close the managed Hunk process             |
| `/hunk review off\|after-run\|live` | Change the automatic-review policy         |
| `/hunk config`                      | Open global settings                       |
| `/hunk config restore`              | Remove global overrides                    |

## Configure

Run `/hunk config` to change the review policy, follow-edits, layout, and shortcuts. Changes save in
Pi's global agent directory (`~/.pi/agent/hunk.json` by default). `PI_CODING_AGENT_DIR` and
`PI_HUNK_CONFIG` are respected. Project-local `.pi/hunk.json` files are ignored; trusted projects
receive a migration warning. Reapply UI settings through `/hunk config` rather than copying a
project-relative `hunk.command` into global config.

Choose a layout directly:

```text
/hunk config full
/hunk config right
/hunk config left
/hunk config float
```

| Layout  | Experience                            |
| ------- | ------------------------------------- |
| `full`  | Hunk fills the terminal. **Default.** |
| `right` | Pi and Hunk side by side              |
| `left`  | Hunk and Pi side by side              |
| `float` | Hunk in a centered overlay            |

Pi wrapping is derived from layout and is not configurable: `left` and `right` wrap Pi into the
remaining columns; `full` and `float` do not.

> **Note:** For the best experience, pi-hunk is intended to be used in full-screen (`full`) mode.
>
> **Warning:** The `left`, `right`, and `float` layouts may use more CPU or feel less responsive,
> especially in large terminals. Switch back to `full` if you notice slower rendering.

`PI_HUNK_REVIEW` can override the saved review policy. Pi-hunk warns when that happens.

Themes, presentation, and Hunk keybindings stay in Hunk's own
[`config.toml`](https://github.com/modem-dev/hunk#configuration).

## Multiple repositories

Pi-hunk opens the repository containing the files Pi changed. If one run changes more than one
repository, use `/hunk next` to move through the queued reviews.

This works with Git, Jujutsu, and Sapling; Hunk chooses the backend using its normal settings.

## Support

When reporting a terminal issue, include your platform, terminal, Pi version, Hunk version, and VCS.

- [Report a bug](https://github.com/igshehata/pi-hunk/issues/new?template=bug.yml)
- [Request a feature](https://github.com/igshehata/pi-hunk/issues/new?template=feature.yml)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
