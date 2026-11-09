---
"pi-hunk": patch
---

Close the review on Ctrl+C instead of leaving Hunk on the terminal. Pi's signal path re-raises
SIGINT without running the extension, so a review open at that moment kept a full-screen Hunk child
alive on the abandoned terminal and left its journal unannounced. While a review is open, pi-hunk
now stops it, prints the journal path on the restored screen, and re-raises the signal, so the host
still dies from SIGINT exactly as before.
