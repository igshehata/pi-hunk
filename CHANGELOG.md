# Changelog

## 0.3.0

### Minor Changes

- 8fcab8a: Default automatic review to off, derive Pi wrapping only from the selected layout, and
  save `/hunk config` and `/hunk review` in Pi's global agent directory without losing concurrent
  updates. Project-local Hunk config is now ignored, with a migration warning in trusted projects.

### Patch Changes

- 8fcab8a: Prevent full-screen Hunk from hanging on “Restoring Hunk…” after it is toggled off and
  back on.

  Restore Oh My Pi compatibility by registering config-backed shortcuts before OMP snapshots
  extensions and treating only terminal `agent_end` events as settled runs.

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
