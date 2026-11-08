---
"pi-hunk": patch
---

Keep the comments saved before a journal record is cut short: an interrupted final append (a kill
mid-write or a full disk) is reported by journal path and line number and skipped, instead of
discarding the whole review. A corrupt record that reached disk completely, or a capture failure the
bridge recorded, still rejects the review.
