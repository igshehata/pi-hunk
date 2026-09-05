# Security policy

## Supported versions

Only the latest stable npm release and the current `main` branch receive security fixes.

| Version                   | Supported |
| ------------------------- | --------- |
| Latest stable npm release | Yes       |
| Current `main`            | Yes       |
| Older releases            | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/igshehata/pi-hunk/security/advisories/new) to
share:

- affected version and platform;
- reproduction steps or a proof of concept;
- expected impact and any known mitigations;
- whether the report may be credited publicly.

You should receive an acknowledgement within seven days. We will coordinate validation, a fix, and
disclosure before publishing details.

## Dependency intake

Repository npm installs enforce a seven-day minimum release age through `.npmrc`. New dependency
versions therefore become eligible only after they have been public for seven days; `npm ci` remains
reproducible from the reviewed lockfile. Maintainers can run `npm run audit` when reviewing
dependency security without blocking unrelated CI changes.

For an urgent security fix that is newer than the waiting period, a maintainer may explicitly run
`npm install --min-release-age=0 <package>@<version>`, review the package and lockfile changes, and
record why the exception was necessary in the pull request. The release-age policy must not be
removed globally to land one emergency update.

## Security model

Pi and OMP extensions execute with the user's permissions. Installing pi-hunk therefore grants it
the same filesystem and process access as the host. Pi-hunk runs the fixed `hunk` executable from
`PATH`, gives it inherited physical-terminal stdio, and loads the bundled feedback bridge. Hunk also
loads extensions from its own trusted configuration; install the host, pi-hunk, Hunk, and other Hunk
extensions only from trusted sources.

The bridge reads the current Hunk process's review snapshot from Hunk's local broker. It writes only
to a private temporary path created by the parent. The parent size-checks and schema-validates that
file, deletes its directory after exit, and submits only a complete authoritative snapshot. Missing,
pending, malformed, oversized, or failed snapshots are not converted into agent feedback.

The global config contains only four key bindings. Cross-process writes use an owner-only lock and
temporary file beside the destination before atomic rename. `PI_HUNK_CONFIG` deliberately permits
trusted automation and tests to select another path.

Saved Hunk comments are sent to the coding agent as a user message. Treat comments from an untrusted
review author as untrusted prompt content.

The published npm package is checked for unexpected source files, production-dependency growth, both
Pi and OMP entry points, and clean-consumer loading before release. `effect` is the sole production
dependency. npm provenance is enabled for published artifacts.
