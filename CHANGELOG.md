# pi-hunk

## 1.0.0

### Major Changes

- a6d5dcc: First stable 1.0.0 release: native full-screen Hunk for Pi and OMP.

### Minor Changes

- 8fcab8a: Store Hunk settings in each host's global agent directory as `pi-hunk.json` and add
  native `/hunk config` dialogs for the prefix, diff/show triggers, and feedback delivery. Validated
  saves are atomic and apply immediately; Cancel discards the draft. Pi and OMP keep independent
  settings, and the former shared XDG configuration path is no longer read.

### Patch Changes

- 8fcab8a: Rebuild Pi and OMP review integration around one shared full-screen Hunk lifecycle.

  Review completion restores the host terminal. Session replacement and shutdown settle the owned
  review before the next session can take over.

  The teardown now signals and settles the complete owned launcher tree before terminal handoff. Fix
  Effect-only bundle validation for hoisted installations. Teardown verifies process identity and
  surfaces bounded cleanup failures instead of silently handing off.
