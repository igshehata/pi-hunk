---
"pi-hunk": patch
---

Opening or switching a review no longer freezes Hunk while pi-hunk verifies the reviewed revision:
the git lookups run in the background, the same changeset is not queried again when it remounts, and
the empty-tree id is resolved once per repository. A comment saved while that lookup is still
running records the revision on screen, never the previous one.
