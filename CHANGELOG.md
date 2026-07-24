# Changelog

## 0.2.0

### Minor Changes

- 5fb9f2d: Open Hunk in a right-side split with Pi word wrapping enabled by default.
- f343d60: Route automatic reviews to every Hunk-reported repository touched by structured mutation targets,
  support explicit cwd routing for pathless shell changes, and skip Hunk-confirmed empty reviews.

## 0.1.0 — 2026-07-18

Initial public release of pi-hunk:

- Review agent-authored changes in a persistent Hunk overlay inside Pi.
- Open reviews automatically after successful changes or follow them live.
- Return fresh inline comments to Pi through the read-only `hunk_review` handoff.
- Review working-copy changes, commits, staged changes, and stashes across supported version-control
  systems.
- Configure review policy, layout, and shortcuts per trusted project.

[0.1.0]: https://github.com/igshehata/pi-hunk/releases/tag/v0.1.0
