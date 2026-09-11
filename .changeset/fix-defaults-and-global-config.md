---
"pi-hunk": minor
---

Store Hunk settings in each host's global agent directory as `pi-hunk.json` and add native
`/hunk config` dialogs for the prefix, diff/show triggers, and feedback delivery. Validated saves
are atomic and apply immediately; Cancel discards the draft. Pi and OMP keep independent settings,
and the former shared XDG configuration path is no longer read.
