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

| Task                    | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `mise run format`       | Format supported files with Oxfmt                   |
| `mise run format:check` | Check formatting without writes                     |
| `mise run lint`         | Run Oxlint                                          |
| `mise run typecheck`    | Run TypeScript without emitting                     |
| `mise run test`         | Run the full Vitest suite                           |
| `mise run build`        | Bundle `dist/index.js`                              |
| `mise run pack`         | Validate the npm tarball and clean consumer install |
| `mise run check`        | Run all release gates                               |
| `mise run changeset`    | Describe a release-worthy change                    |

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
- The `hunk_review` tool is read-only: it must never create, edit, apply, resolve, or clear
  comments.
- Project-local config is loaded only for trusted projects.
- Native dependencies must remain optional Pi peers or bounded runtime dependencies; run
  `mise run pack` after dependency changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
