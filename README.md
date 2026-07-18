<div align="center">

# pi-hunk

**A native Hunk review loop for the Pi coding agent.**

Review agent-authored changes, leave precise inline notes, and send them back to Pi—without leaving
your terminal session or managing an external pane.

[![CI](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml/badge.svg)](https://github.com/igshehata/pi-hunk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-hunk?logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-hunk)
[![Node](https://img.shields.io/node/v/pi-hunk?logo=nodedotjs&color=339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6.svg)](LICENSE)

[Install](#installation) · [Quick start](#quick-start) · [Commands](#commands) ·
[Configuration](#configuration) · [Support](#support)

</div>

## Why pi-hunk?

Coding agents are fast; reviewing their output should not break the loop. Pi-hunk embeds
[Hunk](https://github.com/modem-dev/hunk) as a persistent, Pi-owned overlay and turns review
comments into structured feedback for [Pi](https://github.com/earendil-works/pi).

```text
Pi changes code  →  Hunk opens  →  You annotate  →  Notes return to Pi  →  Pi fixes
```

| Capability                    | What it gives you                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------- |
| **Native overlay**            | Hunk lives inside Pi—no tmux, pane manager, or takeover mode.                     |
| **Persistent review**         | Hide and restore a review without losing position, selection, or comments.        |
| **Human-in-the-loop handoff** | The read-only `hunk_review` tool returns your notes to the active agent run.      |
| **Automatic or live review**  | Open after successful mutations, or watch live from the first mutation attempt.   |
| **Real terminal behavior**    | Mouse, scrolling, resize, colors, comments, and keyboard input survive embedding. |
| **VCS-neutral launch**        | Hunk detects Git, Jujutsu, or Sapling; pi-hunk does not second-guess it.          |

> [!IMPORTANT] Pi-hunk reads Hunk comments but never creates, edits, applies, resolves, or deletes
> them. You remain in control of the review.

## Installation

### Requirements

- [Pi](https://github.com/earendil-works/pi) **0.80+**
- [Hunk](https://github.com/modem-dev/hunk) **0.17+** available on `PATH`
- Node.js **22.19+**
- macOS arm64, or glibc Linux x64/arm64

Install the published Pi package:

```bash
pi install npm:pi-hunk
```

Then reload Pi:

```text
/reload
```

## Quick start

1. Ask Pi to make a code change.
2. Pi-hunk opens after the run using the default `after-run` policy.
3. Review the diff in Hunk and leave inline comments.
4. Press <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> to hide Hunk and submit fresh notes (or
   approve when there are no new notes).
5. Pi receives each unseen note through `hunk_review`, addresses them, and reopens review when
   needed.

### Default shortcuts

| Chord                                               | Action                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>H</kbd> | Open, hide, or restore the persistent review overlay |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd>, then <kbd>S</kbd> | Open, hide, or restore the `hunk show` review        |

Pi-hunk registers only its dedicated prefix with Pi, then captures the configured action hotkey. The
same chords work while Pi has focus and while Hunk owns the overlay. Change the prefix or either
hotkey from `/hunk config` by pressing the actual key—identifiers are never entered as free text.

## Review workflow

Pi-hunk opens one managed Hunk review at a time. Hiding it preserves the review position, selection,
and comments. `/hunk close`, Hunk exit, or a Pi session boundary ends the review.

The agent-facing `hunk_review` tool blocks until review finishes:

- **Hide with new comments:** submit only notes not previously returned in this loaded Pi extension.
- **Hide with no new comments:** return `approved`; this is the human's no-new-findings signal.
- **Close Hunk or press `Q`:** cancel the wait rather than report approval.

Automatic review is deliberately mutation-driven. Conversation-only turns, read-only tools, and
out-of-band workspace changes do not open Hunk. `live` opens at the first mutation preflight so you
can watch the tool, but only successful tool completions count as review evidence. If no mutation
succeeds, pi-hunk closes only the early surface it created for that run and leaves pre-existing or
manual Hunk sessions alone. `approved`, `/hunk close`, and a clean Hunk exit suppress same-run
auto-open; a non-zero Hunk crash can still be recovered by the live policy.

## Commands

| Command                             | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `/hunk`                             | Open the configured watched working-copy diff            |
| `/hunk <target>`                    | Review a Git ref or jj/Sapling revset with `hunk diff`   |
| `/hunk show [target]`               | Review the last commit or a specific revision            |
| `/hunk staged`                      | Review Git staged changes                                |
| `/hunk stash show [ref]`            | Review a Git stash                                       |
| `/hunk toggle`                      | Show or hide the persistent overlay                      |
| `/hunk close`                       | Terminate the managed Hunk process                       |
| `/hunk status`                      | Report policy, layout, session, notes, and diagnostics   |
| `/hunk feedback`                    | Review, then send fresh notes to the agent as a new turn |
| `/hunk review off\|after-run\|live` | Set the trusted project's automatic-review policy        |
| `/hunk config`                      | Open the auto-saving project configuration UI            |
| `/hunk config restore`              | Remove project overrides and restore inherited defaults  |

Hunk's `patch`, `pager`, and `difftool` entrypoints require external stdin or file-pair integration.
Pi-hunk intentionally rejects them; run those commands directly in a terminal.

## Review policies

| Policy      | Behavior                                                                     |
| ----------- | ---------------------------------------------------------------------------- |
| `off`       | Never open automatically; commands and shortcuts remain available.           |
| `after-run` | Open after a successful coding mutation when the agent settles. **Default.** |
| `live`      | Open on the first coding mutation preflight and follow successful edits.     |

Change policy interactively with `/hunk config` or directly:

```text
/hunk review live
```

## Git, Jujutsu, and Sapling

Pi-hunk launches Hunk from Pi's current workspace and passes supported arguments through unchanged.
Hunk remains responsible for repository detection, revision semantics, and diff loading.

```text
/hunk                         # detected VCS working-copy changes
/hunk show HEAD~1             # Git revision
/hunk show @-                 # jj revision
/hunk "trunk()..@"            # jj/Sapling revset
/hunk staged                  # Git only
/hunk stash show stash@{0}    # Git only
```

Hunk's own `vcs = "git" | "jj" | "sl"` setting can override auto-detection. Future VCS adapters in
Hunk require no pi-hunk configuration change.

## Configuration

Run `/hunk config` in a trusted project. Every selection saves immediately to `.pi/hunk.json`; there
is no Save step or scope picker. **Restore defaults** removes the project file after confirmation so
global and shipped values apply again.

A typical sparse project configuration:

```json
{
  "review": "live",
  "overlay": {
    "layout": "right",
    "experimentalPiWrap": false
  },
  "bindings": {
    "prefix": "ctrl+space",
    "toggle": "h",
    "show": "s"
  }
}
```

Configuration precedence, from lowest to highest:

```text
shipped defaults → ~/.pi/agent/hunk.json → trusted .pi/hunk.json → PI_HUNK_REVIEW
```

Available layouts are `full`, `left`, `right`, and `float`. Optional Pi wrapping keeps Pi visible in
the remaining half of a left or right layout.

Pi-hunk does not own Hunk's theme, transparency, presentation, or keybindings. Configure those in
Hunk's `~/.config/hunk/config.toml` or repository-local `.hunk/config.toml`.

## Support

- Reproducible bug:
  [open a bug report](https://github.com/igshehata/pi-hunk/issues/new?template=bug.yml)
- Product idea:
  [request a feature](https://github.com/igshehata/pi-hunk/issues/new?template=feature.yml)
- Security issue: follow the private process in [SECURITY.md](SECURITY.md)

When reporting terminal behavior, include your platform, terminal, Pi version, Hunk version, and
VCS.

## License

Released under the [MIT License](LICENSE).
