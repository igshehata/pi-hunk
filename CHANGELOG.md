# pi-hunk

## 1.1.0

### Minor Changes

- a8d633f: Add a configurable log trigger, defaulting to `Ctrl+Space` then `l`, to launch native
  `hunk log` from Pi and OMP. In a history-selected review, the log chord returns to history without
  handing off feedback. Saved comments across selections retain their original changeset context and
  are handed off together when history closes. For Git reviews, the handoff directs the agent to
  locate comments in the original revision range rather than interpreting historical line numbers
  against current files.

  Diff/show switching remains available in standalone reviews but is intentionally unavailable
  inside history-selected reviews. The log chord does not switch standalone reviews to history.
  Require Hunk 0.22.0 or newer. Warn from the host, without taking the terminal, when `hunk` is
  missing, older than 0.22.0, or cannot be run; pi-hunk does not install or upgrade it.

  Existing custom diff/show triggers using `l` must choose a different `log` trigger to avoid a
  collision. Normalize configuration again at the native review boundary so a launch without the new
  `log` field still initializes shortcuts and captures saved comments.

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
