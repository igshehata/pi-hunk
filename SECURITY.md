# Security policy

## Supported versions

Until the first stable release, only the latest published version and the current `main` branch
receive security fixes.

| Version            | Supported |
| ------------------ | --------- |
| Latest npm release | Yes       |
| Older releases     | No        |

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

Pi extensions execute with the user's permissions. Installing pi-hunk therefore grants it the same
filesystem and process access as Pi. Pi-hunk launches the configured Hunk command in the current
project, reads Hunk's local session metadata, and writes trusted-project `.pi/hunk.json` settings.
Only install the package, project configuration, and Hunk binary from sources you trust.

The published npm package is checked for unexpected source/test files, runtime dependency growth,
and clean-consumer loading before release. npm provenance is enabled for published artifacts.
