<div align="center">

# pi-hunk

**Review Pi's changes in Hunk without leaving Pi.**

Annotate diffs, send comments back to the agent, and keep your review open while Pi continues
working.

[![CI](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml/badge.svg)](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-hunk?logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-hunk)
[![Node](https://img.shields.io/node/v/pi-hunk?logo=nodedotjs&color=339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6.svg)](LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Configure](#configure)

</div>

## What you get

- **Review inside Pi.** No tmux or external pane manager.
- **Automatic reviews.** Open after a change or watch edits live.
- **Inline feedback.** Hide Hunk to send new comments back to Pi.
- **Persistent sessions.** Hide and restore Hunk without losing your place or comments.
- **Multiple repositories.** Review each repository touched in the same agent run.
- **Your VCS, your Hunk setup.** Git, Jujutsu, and Sapling work through Hunk's normal configuration.
- **Flexible layouts.** Use full screen, either side, or a floating window.

> Pi-hunk only reads Hunk comments. It never edits, resolves, applies, or deletes them.

## Install

Requirements:

- [Pi](https://github.com/earendil-works/pi) 0.80+
- [Hunk](https://github.com/modem-dev/hunk) 0.17.6+ on `PATH`
- Node.js 22.19+
- macOS arm64, or glibc Linux x64/arm64

```bash
pi install npm:pi-hunk
```

Then run `/reload` in Pi.

## Quick start

1. Ask Pi to change some code.
2. Hunk opens when Pi finishes.
3. Review the diff and leave inline comments.
4. Press <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> to hide Hunk.
5. Pi receives the new comments as follow-up feedback.

Use the same shortcut to restore the review. If feedback delivery cannot be confirmed, run
`/hunk feedback`; the notes remain recoverable.

## Shortcuts

| Shortcut                                            | Action                                 |
| --------------------------------------------------- | -------------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> | Open, hide, or restore the main review |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>S</kbd> | Open, hide, or restore `hunk show`     |

Change either shortcut from `/hunk config` by pressing the key you want.

## Choose when Hunk opens

| Policy      | Behavior                                                      |
| ----------- | ------------------------------------------------------------- |
| `after-run` | Open after Pi successfully changes code. **Default.**         |
| `live`      | Open on the first change attempt and follow successful edits. |
| `off`       | Never open automatically; commands and shortcuts still work.  |

```text
/hunk review live
```

Automatic review is triggered by Pi's coding tools, not by conversation or read-only work.

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
| `/hunk config`                      | Open project settings                      |
| `/hunk config restore`              | Remove project overrides                   |

## Configure

Run `/hunk config` to change the review policy, follow-edits, layout, and shortcuts. Changes save
immediately to the trusted project's `.pi/hunk.json`.

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
