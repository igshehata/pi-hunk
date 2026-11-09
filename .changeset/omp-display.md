---
"pi-hunk": patch
---

Three display glitches are gone on OMP, with Pi's behaviour unchanged. The `/hunk config` menu
now leads with the state of an unreadable file (`Hunk configuration (unreadable; Save replaces
it) — <path>`), so a long path no longer truncates the part the user must act on. Stopping the
host while a review is open no longer leaves an echoed terminal reply (`^[[6;1;1t`) above the
`pi-hunk: the Hunk review ended without handoff…` notice: the host TUI is not restarted once the
host has begun its own shutdown. And a Hunk process that dies without restoring the terminal
(a crash, a kill, exit code 74) no longer leaves its last screen above the host composer:
pi-hunk undoes Hunk's alternate screen, input modes and hidden cursor before the host repaints.
