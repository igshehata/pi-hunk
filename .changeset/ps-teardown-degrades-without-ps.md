---
"pi-hunk": patch
---

Closing a review no longer fails on hosts without a usable `ps`: pi-hunk finds `ps` on `PATH`, reads
the table in the C locale, and when no table can be read it stops the Hunk process it started and
warns that processes Hunk started may survive, instead of failing the teardown (which made `stop()`
and a session restart reject and left the shortcut dead).
