# Full-screen takeover

Takeover is pi-hunk's only presentation mode.

## Contract

1. Pi calls `TUI.stop()` before Hunk starts.
2. Hunk runs as a child process with inherited stdin, stdout, and stderr.
3. Hunk owns the physical terminal until it exits.
4. Pi calls `TUI.start()` and requests a full repaint after exit.
5. Saved Hunk notes are captured by `dist/hunk-feedback.js` and delivered after Pi resumes.

Quitting Hunk closes the review process. There is no hide, restore, embedded, side-by-side,
floating, PTY-backed, or native-rendering mode.

The supported Hunk command must allow extensions. `--no-extensions` is rejected because the bundled
feedback bridge is required for saved-note handoff on natural exit.
