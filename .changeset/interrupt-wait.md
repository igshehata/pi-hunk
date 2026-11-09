---
"pi-hunk": patch
---

Bound the `interrupt` delivery wait. An abort that never brings the session back to idle left the
review looping in silence: the feedback was never sent, the journal path was never reported, and the
review keys stayed unregistered until the host was stopped. The wait is now capped at 30 seconds,
says what it is waiting for, and queues the comments as a follow-up with the journal path when the
turn does not stop.
