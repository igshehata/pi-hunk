<p align="center">
  <img src="assets/hero.svg" alt="pi-hunk — review in Hunk, return with context" width="1000" />
</p>

# pi-hunk

**Full-screen code review, right inside your agent’s terminal.**

Open [Hunk](https://hunk.dev) from [Pi](https://github.com/earendil-works/pi) or
[Oh My Pi](https://omp.sh), review the changes, and leave comments. Close Hunk and the agent
receives a readable review: comments grouped by the exact revision they refer to, each showing its
file, old and new lines, and the reviewed diff lines. No copy/paste.

[Install](#install) · [Use it](#use-it) · [Configure](#configure)

## Why pi-hunk?

- **Real Hunk.** The full-screen native TUI, not a webview or another diff renderer.
- **Changes, commits, and history.** Switch between working-tree changes and the latest commit, or
  browse native `hunk log` and open selected commits for review.
- **Comments that stay together.** Saved notes survive view switches and returning to history; edits
  replace old text, and deleted notes stay deleted.
- **Your agent’s workflow.** Steer an active turn, queue a follow-up, or interrupt it. The same
  controls work in Pi and OMP.
- **A small integration.** No runtime dependencies: the SDKs come from the hosts, and nothing else
  is bundled.

## Install

You need **Node.js 22.19+**, **Pi or OMP**, and **Hunk 0.22.0+** available as `hunk` on your `PATH`.
[Install Hunk separately](https://hunk.dev); pi-hunk does not download or manage it. If `hunk` is
missing, older than 0.22.0, or cannot be run, the host shows a warning and does not take over the
terminal. pi-hunk never installs or upgrades Hunk for you.

pi-hunk finds `ps` on your `PATH` (falling back to `/bin/ps` and `/usr/bin/ps`) to stop Hunk and the
processes it started when a review ends. Where no process table can be read, it stops the Hunk
process it launched, warns that processes Hunk started may survive, and still closes the review
normally.

### Build this checkout

These instructions install the current source implementation, rather than the previous npm release.

```sh
git clone https://github.com/igshehata/pi-hunk.git
cd pi-hunk
bun install --frozen-lockfile
```

`bun install` also builds the extension through the `prepare` script.

<details>
<summary>Replacing an existing pi-hunk installation?</summary>

Remove the previous package source before linking this checkout:

- **OMP:** `omp plugin uninstall pi-hunk --force`
- **Pi, if installed from npm:** `pi remove npm:pi-hunk`

This removes the host’s package registration, not your checkout.

</details>

### Link your host

Run the command for your host **from the pi-hunk checkout**:

**OMP**

```sh
omp plugin link "$PWD"
```

**Pi**

```sh
pi install "$PWD"
```

**Restart your host**, then open it in the repository you want to review. In OMP, `/reload` does not
remount this extension; use a full restart.

## Use it

Press the prefix, release it, then press the view key:

| Keys                                                  | Opens                              |
| ----------------------------------------------------- | ---------------------------------- |
| <kbd>Ctrl</kbd> + <kbd>Space</kbd>, then <kbd>h</kbd> | Index vs working tree: `hunk diff` |
| <kbd>Ctrl</kbd> + <kbd>Space</kbd>, then <kbd>s</kbd> | Latest commit: `hunk show`         |
| <kbd>Ctrl</kbd> + <kbd>Space</kbd>, then <kbd>l</kbd> | Native history: `hunk log`         |

1. **Open a view** from your agent’s terminal.
2. **Review and save comments** using Hunk’s normal controls.
3. **Switch diff/show views with the same keys** while on Hunk’s main review screen. Your saved
   comments stay together.
4. **Close Hunk** to return to the agent and hand off your feedback. In a standalone review, this is
   normally <kbd>q</kbd>; in a log review, return to history first, then quit history.

The prefix has no timeout. <kbd>Escape</kbd> cancels it; an unrelated next key passes through
normally. Selecting the current diff/show view does nothing. Hunk controls native input routing:
note-editor text is not interpreted as a view chord. Help and open menus do not necessarily disable
view shortcuts.

### History and Back

Launch `hunk log` with the log chord **from the agent’s terminal**. History keeps Hunk’s native
controls: select commits or a range, then press <kbd>Enter</kbd> to review them. On the selected
review’s main screen, the log chord acts like native <kbd>q</kbd>: it returns to the retained
history screen without closing Hunk or handing off comments. Quit history to submit the saved
comments from all selections together. Every saved comment records the exact revision its line
numbers refer to, as full commit SHAs; a comment keeps that revision if it is edited later. Diff
comments record the index and the working tree—their old side is the index (staged content) and
their new side is the working tree. Show and history comments record the reviewed commit and its
parent, or the selected range, so old/new line ranges are read against those versions rather than
today’s files, even if the code or file was later removed or renamed. Renames also record the file’s
previous path. When Hunk’s revision cannot be verified with Git, the comment records Hunk’s own text
as unresolved instead of guessing. Git verification runs in the background, so opening or switching
a review renders immediately; a comment saved before that lookup finishes still records the revision
on screen at that moment, never the previous one.

The handoff is readable on its own. Comments are grouped by the exact revision they refer to, each
shows its file, old and new lines, and the reviewed diff lines around the comment, and replies
appear directly under the comment they answer. pi-hunk adds no instructions of its own: how a review
should be handled is your choice, so put that guidance in `AGENTS.md` or a skill.

The prefix is not active on the history screen. Diff/show switching is intentionally unavailable
inside history-selected reviews; those chords show a notice and leave the selection unchanged. The
log chord does not switch a standalone diff/show review to history—close that review and launch log
from the agent.

**Only saved comments are sent.** Unsaved drafts are not submitted, deleted notes are omitted, a
reply whose comment was deleted is marked as such, and closing an empty review sends no message.
Each new review starts fresh.

Starting a new session while a review is open waits for Hunk to close, then sets up the new session.
If pi-hunk cannot verify that Hunk’s process tree has exited, it reports that cleanup failure and
still sets up the new session; close any leftover `hunk` process yourself.

## Configure

No configuration is required. Run **`/hunk config`** in Pi or OMP to open the host’s native
interactive menu for the prefix, diff key, show key, log key, and feedback delivery. **Save**
persists your changes and applies them immediately—no restart needed. **Cancel** or
<kbd>Escape</kbd> from the main menu discards the draft; <kbd>Escape</kbd> from a field returns to
the menu without changing that field. Finish any active review before opening the menu.

Settings are global to your active host/profile and independent between Pi and OMP. The default
files are:

- **OMP:** `~/.omp/agent/pi-hunk.json`
- **Pi:** `~/.pi/agent/pi-hunk.json`

Native agent-directory overrides and profiles are honored. These files belong to pi-hunk; your
host’s `config.yml` or `settings.json` is left untouched. You can also edit the file directly:

```json
{
  "prefix": "ctrl+space",
  "diff": "h",
  "show": "s",
  "log": "l",
  "delivery": "steer"
}
```

Every field is optional; omitted fields keep the defaults above. For example, `"prefix": "alt+z"`,
`"diff": "d"`, `"show": "v"`, and `"log": "g"` give you another set of bindings. All three view keys
must differ, and `escape` is reserved for canceling the prefix. Invalid configuration is reported,
not silently repaired.

If an existing configuration uses `l` for diff or show, set `log` to a different key when upgrading;
the new default log trigger must not collide with either existing trigger.

Direct file edits take effect on the next host/session start. To apply them now, open `/hunk config`
and Save. Changes made through the command take effect immediately. Installing a new extension build
still requires a full host restart—OMP’s `/reload` is not enough. If your OS or terminal intercepts
<kbd>Ctrl</kbd> + <kbd>Space</kbd>, free that binding or choose another prefix.

### When the agent is busy

| `delivery`          | What happens when you close Hunk                                                  |
| ------------------- | --------------------------------------------------------------------------------- |
| `"steer"` — default | Queue feedback to steer the current turn at the host’s next steering opportunity. |
| `"followUp"`        | Wait for the current turn to finish, then send the feedback.                      |
| `"interrupt"`       | Abort the current turn, wait until the agent is idle, then send the feedback.     |

When the agent is already idle, all three modes send feedback as a new user message and start a
turn.

An interrupt waits up to 30 seconds for the aborted turn to become idle. If the turn does not stop
in time, the feedback is queued as a follow-up and the journal path is reported, so the comments are
never dropped and the review keys come back.

### Recovering feedback

Nonempty reviews retain a local temporary journal, including after handoff: calling the host’s send
API is not a delivery receipt. If capture or handoff fails, pi-hunk reports the journal path for
recovery rather than silently discarding your work. Stopping the host while a review is open keeps
its journal too; the path is printed as the host exits, because the review UI is already gone when
that happens. An interrupt (<kbd>Ctrl</kbd> + <kbd>C</kbd>) counts as a stop: pi-hunk closes Hunk,
prints the journal path, and the host exits the way it would without the review. Journals contain
comment text and file paths; treat them as local review data.

A journal is appended one record at a time, so a kill or a full disk can leave the last record
half-written. That unfinished final record is reported by journal path and line number and skipped;
every comment saved before it is still handed off. A corrupt record that did reach disk completely,
or a capture failure the bridge recorded, still rejects the whole review rather than handing off a
partial one.

## Development

After changing runtime source, run `bun run build` and restart your host. To run formatting, lint,
type, regression, and packed-install checks:

```sh
bun run check
```

The extension is for interactive TUI sessions, targeting macOS and Linux. Native smoke coverage:
**macOS**, with Pi **0.84.4**, OMP **18.1.10**, and Hunk **0.22.0**. Linux native smoke verification
has not yet been performed.

## License

[MIT](LICENSE). Hunk, Pi, and OMP are separate projects with their own licenses.
