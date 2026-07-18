# Changesets

Add a Changeset for every user-visible fix or feature:

```bash
mise run changeset
```

Commit the generated Markdown file with the implementation. The release workflow consumes pending
Changesets into a version pull request and publishes after that pull request merges.

Repository-only documentation, tests, refactors, and tooling changes generally do not need a
Changeset. See [docs/releasing.md](../docs/releasing.md) for the full cycle.
