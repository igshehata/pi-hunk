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

`mise run setup` installs the locked Bun dependencies and points `core.hooksPath` at `.githooks/`.
The pre-commit hook runs formatting, lint, and type checks. The pre-push hook runs all release
gates. Hooks are a safety net, not a replacement for running the relevant task while developing.

Run `mise run` to list available tasks. Bun dependency resolution applies the repository's seven-day
minimum release age from `bunfig.toml`; do not bypass it except for a reviewed emergency security
update as described in [SECURITY.md](SECURITY.md). npm is used only for registry operations
(`npm pack`, staging, and publishing with provenance); installs and scripts run through Bun.

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

| Task                              | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `mise run format`                 | Format supported files with Oxfmt                   |
| `mise run format:check`           | Check formatting without writes                     |
| `mise run lint`                   | Run Oxlint                                          |
| `mise run typecheck`              | Run TypeScript without emitting                     |
| `mise run test`                   | Run the full Vitest suite                           |
| `mise run build`                  | Bundle `dist/index.js`                              |
| `mise run pack`                   | Validate the npm tarball and clean consumer install |
| `mise run check`                  | Run all release gates                               |
| `mise run changeset`              | Describe a release-worthy change                    |
| `mise run release:canary`         | Stage a canary of `main`, then publish it with 2FA  |
| `mise run release:canary:preview` | Preview the canary identity without changing files  |

## Release streams

Pi-hunk has two npm streams:

- **Stable 1.x** uses the `latest` npm tag. Add Changesets normally. Each push to `main` creates or
  updates the Changesets version PR when changesets are pending; it does not stage the old stable
  version. Review and merge that PR only when `package.json`, the lockfile, and `CHANGELOG.md` show
  the intended stable version. The merge push stages stable only when no changesets remain and the
  registry preflight confirms that version is unpublished. An already-published stable version is
  not staged again. Inspect and explicitly approve the staged package, then run
  `finalize-release.yml` with that exact version. Finalization creates the immutable `vX.Y.Z` tag
  and GitHub Release and rejects prerelease versions.
- **Canary** is the `canary` npm tag, for testing a build before it reaches users. It is on demand
  and builds `main` only: merge, then run `mise run release:canary` from a clean `main` checkout
  whose HEAD matches `origin/main`. It dispatches `canary.yml` on `main` (the workflow fails on any
  other ref), correlates only the run id the dispatch returns, and waits for the run to verify and
  stage the package (about two minutes). It then checks the stage against the run's artifact
  (package, version, tag, commit, and SHA-1) and asks whether to publish. Answering `y` runs
  `npm stage approve <stage-id>`, so npm asks for your 2FA; anything else, or a non-interactive run,
  leaves the stage for you to approve later. Versions are `0.0.0-canary.<run-id>.<run-attempt>`, so
  they never satisfy a semver range and never collide. `mise run release:canary -- --dry-run` checks
  the git identity and prints the plan. Canaries get no Git tag or GitHub Release; do not run the
  finalization workflow for one. Requires authenticated `gh` and `npm`.

Stable lives in `release.yml`, bound by npm trusted publishing to that workflow and the
`npm-release` environment, whose reviewer gate is approved in GitHub before staging. Canary lives in
`canary.yml` with its own trusted publishing configuration and no GitHub environment, so it neither
waits for a reviewer nor shares the stable queue. Both configurations are staging only: nothing
becomes public without `npm stage approve` and the maintainer's npm 2FA, so a compromised workflow
can stage a package but never publish one.

## Testing expectations

Unit tests are useful for contracts, but overlay, PTY, input, lifecycle, and review-handoff changes
need integration coverage and an interactive smoke test where practical.

Process fixtures must isolate `PATH`, `HOME`, and XDG directories from the real Hunk installation.
Register cleanup for test completion, including timeouts, and await `host.stop()` before restoring
the environment or removing fixture executables. A test timeout does not cancel its asynchronous
work; a pending launch must never fall through to a real `hunk` or leave a shared daemon running.

When investigating an installed-host failure, reproduce it with normal extension discovery and the
actual terminal environment before switching to isolated fixtures. Report those checks separately;
an isolated handoff does not prove the installed environment works.

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
