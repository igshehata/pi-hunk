---
"pi-hunk": major
---

Add a `mode` setting. `"multiplexer"` opens Hunk in a pane beside the agent in Tern, Rex, or Herdr,
and delivers each saved comment, edit, deletion, or reply as it happens instead of one handoff on
close. `"static"`, the default, is unchanged: full-screen Hunk, comments sent when you close it.
Hunk 0.25.0 or newer is now required.
