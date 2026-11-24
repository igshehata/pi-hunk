---
"pi-hunk": minor
---

Batch comments in multiplexer mode. Set `comments` to `batch` in `/hunk config` and saved comments
wait in Hunk instead of reaching the agent one by one. Press the prefix then <kbd>Enter</kbd> (the
new `send` key) in Hunk to send everything queued as one message; quitting Hunk sends the rest. The
status line shows how many changes are queued. The default stays `live`.
