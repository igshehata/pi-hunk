# Contributing

Pi-hunk sits across Pi/OMP lifecycle events, one Effect state machine, child-process ownership,
physical-terminal handoff, and Hunk's extension/session APIs. Keep changes small and explicit about
which boundary they affect.

## Setup

Requirements are [mise](https://mise.jdx.dev), Git, and the platform requirements listed in the
README.

```bash
git clone git@github.com:igshehata/pi-hunk.git
cd pi-hunk
mise trust
mise run setup
mise run check
```

`mise run setup` installs the locked npm dependencies and points `core.hooksPath` at `.githooks/`.
The pre-commit hook runs formatting, lint, and type checks. The pre-push hook runs all release
gates. Hooks are a safety net, not a replacement for exercising changed behavior while developing.

Run `mise run` to list available tasks. npm dependency resolution applies the repository's seven-day
minimum release age; do not bypass it except for a reviewed emergency security update as described
in [SECURITY.md](SECURITY.md).

## Development workflow

1. Open an issue first for large behavior or public-schema changes.
2. Reproduce the behavior through the actual Pi/Hunk path before changing it.
3. Make the smallest source fix that preserves the full-screen takeover contract.
4. Run the specific command or interactive scenario that proves the changed behavior.
5. Run `mise run format` and `mise run check` before pushing.
6. Add a Changeset with `mise run changeset` for published behavior changes. Documentation and
   repository-only maintenance generally do not need one.
7. Keep commits focused enough to review without rewriting working history solely for aesthetics.

Do not build a speculative unit suite around implementation details. Add a regression only for an
observed bug and defend an observable contract. Terminal, lifecycle, hotkey, and feedback claims
must be verified through packaged real Pi and OMP processes under Herdr.

## Useful tasks

| Task                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `mise run format`                 | Format supported files with Oxfmt                          |
| `mise run format:check`           | Check formatting without writes                            |
| `mise run lint`                   | Run Oxlint                                                 |
| `mise run typecheck`              | Run TypeScript without emitting                            |
| `mise run build`                  | Bundle `dist/index.js` and `dist/hunk-feedback.js`         |
| `mise run pack`                   | Validate the npm tarball and clean consumer install        |
| `mise run check`                  | Run every static, build, and package release gate          |
| `mise run changeset`              | Describe a release-worthy change                           |
| `mise run release:canary:preview` | Preview the rolling canary identity without changing files |

## Release streams

Pi-hunk has two npm streams:

- **Stable 1.x** uses the `latest` npm tag. Add Changesets normally, merge the generated version PR,
  approve the package staged by `.github/workflows/release.yml`, then run `finalize-release.yml`
  with that exact stable version. Finalization creates the immutable `vX.Y.Z` tag and GitHub Release
  and rejects prerelease versions.
- **Canary** is the rolling `canary` npm tag, independent of the stable Changesets plan. Preview its
  deterministic identity with `mise run release:canary:preview`, then dispatch the **Release**
  workflow from `main` (or run `gh workflow run release.yml --ref main`). Users always select
  `pi-hunk@canary`; npm's immutable registry requires each underlying artifact to use a unique
  `0.0.0-canary.<run-number>.<run-attempt>` SemVer. The workflow verifies and stages that exact
  tarball and waits for npm 2FA approval. Do not run the finalization workflow for a canary.

Both streams stay in `release.yml` because npm trusted publishing is bound to that workflow and the
`npm-release` environment. Canary releases never create Git tags or GitHub Releases.

## Verification expectations

For terminal or lifecycle changes, run the affected packaged Herdr scenarios against both real Pi
and OMP hosts with Hunk 0.20.1 or newer. Verify the exact transition changed: launch, Hunk
interaction, child exit, repaint, feedback delivery, or forced shutdown. Static checks and a
successful bundle do not prove terminal ownership.

## Pull requests

A pull request should include:

- a concise problem statement and the chosen behavior;
- the exact command or scenario used to verify it;
- documentation updates for public behavior or configuration;
- a Changeset when published package behavior changes;
- platform, Pi, Hunk, and terminal details for terminal/input fixes.

Do not include generated `dist/` output; the package build creates it during preparation.

## Design constraints

- One tagged Effect state machine owns every chooser, configuration, launch, running, switching,
  delivery, and shutdown transition.
- Pi-hunk owns one full-screen child process; the host and Hunk never render concurrently.
- Hunk receives inherited physical-terminal stdio and remains authoritative for terminal behavior,
  diff presentation, and comments.
- The bundled Hunk extension may read saved user notes only. Pi-hunk must never create, edit, apply,
  resolve, remove, or clear comments.
- Pi-hunk configuration is global and contains only four hotkeys; project-local files are ignored.
- `effect` is the sole production dependency. Do not add a PTY or terminal-emulator dependency.
- Run `mise run pack` after package, build, or dependency changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
