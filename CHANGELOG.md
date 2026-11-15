# pi-hunk

## 2.0.0

### Major Changes

- e5071a7: Add a `mode` setting. `"multiplexer"` opens Hunk in a pane beside the agent in Tern, Rex,
  or Herdr, and delivers each saved comment, edit, deletion, or reply as it happens instead of one
  handoff on close. `"static"`, the default, is unchanged: full-screen Hunk, comments sent when you
  close it. Hunk 0.25.0 or newer is now required.

### Minor Changes

- e5071a7: Add `branch` and `codebase` views: the branch view reviews everything since the branch
  left its base branch, and the codebase view reviews every tracked and untracked, non-ignored file,
  each with its own trigger key and switchable inside Hunk like diff and show.

## 1.2.0

### Minor Changes

- 1838fb0: Every saved review comment now records the exact revision its line numbers refer to — the
  index and working tree, a commit with its parent, or a history range — as full commit SHAs.
- d51f6ad: Review comments now reach the agent as a readable review: grouped by exact revision, with
  old/new line labels, the reviewed diff lines, and replies under the comment they answer — no JSON
  dump.

### Patch Changes

- 7ca512f: Opening or switching a review no longer freezes Hunk while pi-hunk verifies the reviewed
  revision: the git lookups run in the background, the same changeset is not queried again when it
  remounts, and the empty-tree id is resolved once per repository. A comment saved while that lookup
  is still running records the revision on screen, never the previous one.
- ba0fb57: Bound the `interrupt` delivery wait. An abort that never brings the session back to idle
  left the review looping in silence: the feedback was never sent, the journal path was never
  reported, and the review keys stayed unregistered until the host was stopped. The wait is now
  capped at 30 seconds, says what it is waiting for, and queues the comments as a follow-up with the
  journal path when the turn does not stop.
- d70e4d4: A comment pi-hunk cannot record no longer kills Hunk mid-render. The failure is journaled
  and shown as an error notice while the review (drafts included) stays on screen, and closing that
  review reports the cause and the journal path instead of handing off a partial review; Hunk exits
  at once only when the journal cannot take the failure notice itself.
- 6cf2803: Three display glitches are gone on OMP, with Pi's behaviour unchanged. The `/hunk config`
  menu now leads with the state of an unreadable file
  (`Hunk configuration (unreadable; Save replaces it) — <path>`), so a long path no longer truncates
  the part the user must act on. Stopping the host while a review is open no longer leaves an echoed
  terminal reply (`^[[6;1;1t`) above the `pi-hunk: the Hunk review ended without handoff…` notice:
  the host TUI is not restarted once the host has begun its own shutdown. And a Hunk process that
  dies without restoring the terminal (a crash, a kill, exit code 74) no longer leaves its last
  screen above the host composer: pi-hunk undoes Hunk's alternate screen, input modes and hidden
  cursor before the host repaints.
- e225e7a: Closing a review no longer fails on hosts without a usable `ps`: pi-hunk finds `ps` on
  `PATH`, reads the table in the C locale, and when no table can be read it stops the Hunk process
  it started and warns that processes Hunk started may survive, instead of failing the teardown
  (which made `stop()` and a session restart reject and left the shortcut dead).
- bf9f0dc: Drop the bundled Effect runtime: the package is much smaller and loads faster. Review
  lifecycles are now explicit state machines; behaviour is unchanged.
- 446bfda: Review handoffs name commits by their short SHA, as `git log --oneline` does, instead of
  the full 40-character id.
- c6f81a9: Close the review on Ctrl+C instead of leaving Hunk on the terminal. Pi's signal path
  re-raises SIGINT without running the extension, so a review open at that moment kept a full-screen
  Hunk child alive on the abandoned terminal and left its journal unannounced. While a review is
  open, pi-hunk now stops it, prints the journal path on the restored screen, and re-raises the
  signal, so the host still dies from SIGINT exactly as before.
- 277c932: A failed cleanup of the previous review no longer leaves the replacement session without
  the Hunk key chord: pi-hunk reports the cleanup failure and still loads the new session.
- c1a0014: Keep and report a review’s journal when stopping the host ends it: the recovery path is
  printed as the host exits instead of saved comments being discarded silently.
- 83dad17: Keep the comments saved before a journal record is cut short: an interrupted final append
  (a kill mid-write or a full disk) is reported by journal path and line number and skipped, instead
  of discarding the whole review. A corrupt record that reached disk completely, or a capture
  failure the bridge recorded, still rejects the review.
- e81be87: Keep Hunk working with a configuration a different build wrote: an unknown field is
  reported by name and ignored while the known settings apply, and a file that cannot be parsed no
  longer makes `/hunk config` fail — the startup notice names the file, the error, and the next
  step, and the menu opens from defaults so Save can replace the broken file (Cancel leaves it
  untouched).

## 1.1.0

### Minor Changes

- a8d633f: Add a configurable log trigger, defaulting to `Ctrl+Space` then `l`, to launch native
  `hunk log` from Pi and OMP. In a history-selected review, the log chord returns to history without
  handing off feedback. Saved comments across selections retain their original changeset context and
  are handed off together when history closes. For Git reviews, the handoff directs the agent to
  locate comments in the original revision range rather than interpreting historical line numbers
  against current files.

  Diff/show switching remains available in standalone reviews but is intentionally unavailable
  inside history-selected reviews. The log chord does not switch standalone reviews to history.
  Require Hunk 0.22.0 or newer. Warn from the host, without taking the terminal, when `hunk` is
  missing, older than 0.22.0, or cannot be run; pi-hunk does not install or upgrade it.

  Existing custom diff/show triggers using `l` must choose a different `log` trigger to avoid a
  collision. Normalize configuration again at the native review boundary so a launch without the new
  `log` field still initializes shortcuts and captures saved comments.

## 1.0.0

### Major Changes

- a6d5dcc: First stable 1.0.0 release: native full-screen Hunk for Pi and OMP.

### Minor Changes

- 8fcab8a: Store Hunk settings in each host's global agent directory as `pi-hunk.json` and add
  native `/hunk config` dialogs for the prefix, diff/show triggers, and feedback delivery. Validated
  saves are atomic and apply immediately; Cancel discards the draft. Pi and OMP keep independent
  settings, and the former shared XDG configuration path is no longer read.

### Patch Changes

- 8fcab8a: Rebuild Pi and OMP review integration around one shared full-screen Hunk lifecycle.

  Review completion restores the host terminal. Session replacement and shutdown settle the owned
  review before the next session can take over.

  The teardown now signals and settles the complete owned launcher tree before terminal handoff. Fix
  Effect-only bundle validation for hoisted installations. Teardown verifies process identity and
  surfaces bounded cleanup failures instead of silently handing off.
