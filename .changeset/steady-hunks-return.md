---
"pi-hunk": patch
---

Rebuild Pi and OMP review integration around one shared full-screen Hunk lifecycle.

Review completion restores the host terminal. Session replacement and shutdown settle the owned
review before the next session can take over.

The teardown now signals and settles the complete owned launcher tree before terminal handoff. Fix
Effect-only bundle validation for hoisted installations. Teardown verifies process identity and
surfaces bounded cleanup failures instead of silently handing off.
