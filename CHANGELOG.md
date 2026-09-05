# Changelog

## 1.0.0 — 2026-08-29

### Major Changes

- Reduce pi-hunk to one manual full-screen takeover for both Pi and Oh My Pi. The host stops its
  TUI, Hunk inherits the physical terminal directly, and the host restarts after Hunk exits.
- Remove overlays, alternate layouts, automatic reviews, repository routing, hide/restore,
  persistent sessions, native PTY/rendering code, and their configuration and commands.
- Replace the runtime with one explicit tagged Effect state machine. Chooser, configuration, launch,
  switching, feedback delivery, and shutdown now share one serialized lifecycle.
- Limit global configuration to the prefix plus `diff`, `show`, and `stash` action keys. Writes are
  cross-process serialized and atomically committed.
- Capture the final authoritative saved-user-note set through the bundled Hunk extension and fail
  closed rather than deliver stale notes. Hunk 0.20.1 or newer (extension API 8+) is required.
- Make `effect` the sole production dependency; remove zigpty, libghostty, test-runner tooling, and
  every speculative unit test.
- Add independent black-box Herdr coverage against real Pi and OMP processes for all modes,
  commands, host and in-Hunk chords, exact comment capture, deletion, cross-mode switching, and
  shutdown.

## 0.2.0

### Minor Changes

- 45a4407: Open full-screen by default, keep Pi visible beside left and right layouts, and prevent
  partial Hunk frames from flashing.
- f343d60: Open automatic reviews for every repository Pi changes, queue additional repositories,
  and skip empty reviews without guessing unresolved shell paths.

### Patch Changes

- 2eba995: Send new comments back to Pi whenever Hunk is hidden, including for manually opened
  reviews, without blocking the agent.
- 30a3ce1: Prevent lost feedback, reviews opening in the wrong repository, config corruption,
  lingering Hunk processes, broken keyboard or mouse input, and startup screen glitches.
- 2b81233: Keep inline comments recoverable after failed delivery and warn when a shell change
  cannot be routed to a repository.
- 2b81233: Make floating and side-by-side reviews smoother and require Hunk 0.17.6 or newer for
  reliable startup.

## 0.1.0 — 2026-07-18

Initial public release of pi-hunk:

- Review agent-authored changes in a persistent Hunk overlay inside Pi.
- Open reviews automatically after successful changes or follow them live.
- Return fresh inline comments to Pi through the read-only `hunk_review` handoff.
- Review working-copy changes, commits, staged changes, and stashes across supported version-control
  systems.
- Configure review policy, layout, and shortcuts per trusted project.

[0.1.0]: https://github.com/igshehata/pi-hunk/releases/tag/v0.1.0
