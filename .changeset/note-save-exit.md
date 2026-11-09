---
"pi-hunk": patch
---

A comment pi-hunk cannot record no longer kills Hunk mid-render. The failure is journaled and shown
as an error notice while the review (drafts included) stays on screen, and closing that review
reports the cause and the journal path instead of handing off a partial review; Hunk exits at once
only when the journal cannot take the failure notice itself.
