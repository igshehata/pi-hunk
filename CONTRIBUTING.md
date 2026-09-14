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

| Task                              | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `mise run format`                 | Format supported files with Oxfmt                            |
| `mise run format:check`           | Check formatting without writes                              |
| `mise run lint`                   | Run Oxlint                                                   |
| `mise run typecheck`              | Run TypeScript without emitting                              |
| `mise run test`                   | Run the full Vitest suite                                    |
| `mise run build`                  | Bundle `dist/index.js`                                       |
| `mise run pack`                   | Validate the npm tarball and clean consumer install          |
| `mise run check`                  | Run all release gates                                        |
| `mise run changeset`              | Describe a release-worthy change                             |
| `mise run release:canary`         | Dispatch canary from matching main and stop at the npm stage |
| `mise run release:canary:preview` | Preview the rolling canary identity without changing files   |

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
- **Canary** is the rolling `canary` npm tag, independent of the stable Changesets plan. Every push
  to `main` automatically verifies and stages a canary, including pushes with pending changesets or
  an already-published stable version. There is no separate canary branch. For an optional on-demand
  canary, from a clean checkout whose HEAD matches `origin/main`, run `mise run release:canary`. It
  dispatches `release.yml` as `workflow_dispatch` on `main`, correlates only the run id returned by
  that dispatch, waits through `npm-release` environment protection without bypassing it, and stops
  at the exact staged tarball. Remaining npm 2FA approval is `npm stage approve <stage-id>`; this
  command never approves, publishes, tags, or creates a GitHub Release. Optional
  `mise run release:canary -- --dry-run` checks the git identity and prints that plan.
  `mise run release:canary:preview` only shows the `0.0.0-canary.<run-number>.<run-attempt>`
  formula. Users install `pi-hunk@canary`. Do not run the finalization workflow for a canary.
  Requires authenticated `gh` and `npm` with access to the repository and its staged packages, and a
  GitHub CLI/API combination that returns the dispatched run ID. If no ID is returned, the command
  stops rather than guessing. Commit and merge the desired code into `main` before running it; this
  command does not commit, push, or merge changes. This is a user-invoked dispatch helper, never
  called from CI, and does not inspect push-triggered runs. Manual `workflow_dispatch` on `main`
  stages canary only, not stable.

Both streams stay in `release.yml` because npm trusted publishing is bound to that workflow and the
`npm-release` environment. When a push plans both streams, both verifications must succeed before
either can stage. Staging still honors the GitHub environment gate; it is not npm publication.
Inspect the exact stage (package, version, tag, source commit, and tarball), then explicitly run
`npm stage approve <stage-id>` with npm 2FA to publish. Neither automatic push staging nor the
manual helper approves npm stages. Canary releases never create Git tags or GitHub Releases.

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
