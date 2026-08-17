# Contributing

Thanks for helping improve pi-hunk. The project sits across Pi lifecycle events, terminal rendering,
a native PTY, version-control integration, and Hunk, so changes should be small, testable, and
explicit about which boundary they affect.

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
gates. Hooks are a safety net, not a replacement for running the relevant task while developing.

Run `mise run` to list available tasks. npm dependency resolution applies the repository's seven-day
minimum release age; do not bypass it except for a reviewed emergency security update as described
in [SECURITY.md](SECURITY.md).

## Development workflow

1. Open an issue first for large behavior or public-schema changes.
2. Add or update tests at the same boundary as the behavior. Avoid claiming terminal integration
   from a parser-only test.
3. Run `mise run format` before committing.
4. Run `mise run check` before pushing.
5. Add a Changeset with `mise run changeset` for user-visible fixes or features. Documentation,
   tests, and repository-only maintenance generally do not need one.
6. Keep commits focused enough to review without rewriting working history solely for aesthetics.

## Useful tasks

| Task                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `mise run format`                 | Format supported files with Oxfmt                          |
| `mise run format:check`           | Check formatting without writes                            |
| `mise run lint`                   | Run Oxlint                                                 |
| `mise run typecheck`              | Run TypeScript without emitting                            |
| `mise run test`                   | Run the full Vitest suite                                  |
| `mise run build`                  | Bundle `dist/index.js`                                     |
| `mise run pack`                   | Validate the npm tarball and clean consumer install        |
| `mise run check`                  | Run all release gates                                      |
| `mise run changeset`              | Describe a release-worthy change                           |
| `mise run release:canary:preview` | Preview the rolling canary identity without changing files |

## Release streams

Pi-hunk has two npm streams:

- **Stable 0.3.x** uses the `latest` npm tag. Add Changesets normally, merge the generated version
  PR, approve the package staged by `.github/workflows/release.yml`, then run `finalize-release.yml`
  with that exact stable version. Finalization creates the immutable `vX.Y.Z` tag and GitHub Release
  and rejects prerelease versions.
- **Canary** is the rolling `canary` npm tag, independent of the stable Changesets plan. Preview its
  deterministic identity with `mise run release:canary:preview`, then dispatch the **Release**
  workflow from `main` (or run `gh workflow run release.yml --ref main`). Users always select
  `pi-hunk@canary`; npm's immutable package registry requires each underlying artifact to use a
  unique `0.0.0-canary.<run-number>.<run-attempt>` SemVer. The workflow verifies and stages that
  exact tarball and waits for npm 2FA approval. Do not run the finalization workflow for a canary.

Both streams stay in `release.yml` because npm trusted publishing is bound to that workflow and the
`npm-release` environment. Canary releases never create Git tags or GitHub Releases.

## Testing expectations

Unit tests are useful for contracts, but overlay, PTY, input, lifecycle, and review-handoff changes
need integration coverage and an interactive smoke test where practical.

## Pull requests

A pull request should include:

- a concise problem statement and the chosen behavior;
- tests that would fail without the change;
- documentation updates for public behavior or configuration;
- a Changeset when the published package behavior changes;
- platform, Pi, Hunk, and terminal details for rendering/input fixes.

Do not include generated `dist/` output; the package build creates it during preparation.

## Design constraints

- Pi-hunk owns one native persistent overlay and one managed Hunk process.
- Hunk remains authoritative for diff presentation and comments.
- Comment handoff is read-only: pi-hunk must never create, edit, apply, resolve, remove, or clear
  comments.
- Pi-hunk configuration is global; project-local `.pi/hunk.json` files are ignored.
- Native dependencies must remain optional Pi peers or bounded runtime dependencies; run
  `mise run pack` after dependency changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
