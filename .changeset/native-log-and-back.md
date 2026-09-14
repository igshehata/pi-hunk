---
"pi-hunk": minor
---

Add a configurable log trigger, defaulting to `Ctrl+Space` then `l`, to launch native `hunk log`
from Pi and OMP. In a history-selected review, the log chord returns to history without handing off
feedback. Saved comments across selections retain their original changeset context and are handed
off together when history closes. For Git reviews, the handoff directs the agent to locate comments
in the original revision range rather than interpreting historical line numbers against current
files.

Diff/show switching remains available in standalone reviews but is intentionally unavailable inside
history-selected reviews. The log chord does not switch standalone reviews to history. Require Hunk
0.22.0 or newer. Warn from the host, without taking the terminal, when `hunk` is missing, older than
0.22.0, or cannot be run; pi-hunk does not install or upgrade it.

Existing custom diff/show triggers using `l` must choose a different `log` trigger to avoid a
collision. Normalize configuration again at the native review boundary so a launch without the new
`log` field still initializes shortcuts and captures saved comments.
