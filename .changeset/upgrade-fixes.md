---
"pi-hunk": patch
---

Three fixes for upgrading to 2.0. A 1.x configuration whose key is now a default of the new `branch`
(`b`) or `codebase` (`c`) view no longer fails with a generic error: the message names both views
and the key, and says to set the new view to another key or change yours (any other clash names its
two views too). In multiplexer mode outside Tern, Rex, or Herdr, the full-screen fallback review now
behaves exactly like static mode, without the `pi-hunk live · 0 sent` status line or stale marks;
the saved mode is unchanged. And the README now says to run `hunk daemon restart` after upgrading
Hunk: a daemon from the older Hunk keeps running and shows Hunk's `Run hunk daemon restart` warning
in place of pi-hunk's status line.
