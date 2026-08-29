---
"pi-hunk": major
---

Reduce pi-hunk to one full-screen Hunk takeover. Remove embedded, side-by-side, floating,
hide/restore, and persistent-session behavior; remove the layout configuration, zigpty, libghostty,
native terminal rendering, and all runtime dependencies.

Pi now stops its TUI while Hunk inherits the physical terminal, then restarts after Hunk exits. A
bundled Hunk extension captures saved user notes before the child unregisters its session so
feedback can be delivered after Pi resumes. Hunk 0.18.2 or newer is required.
