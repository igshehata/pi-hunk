# Host modes (shipped on feat/host-modes-and-atomic-frames)

## Modes

| Mode | Config | Layouts | Paint path |
| --- | --- | --- | --- |
| **Embed** (default) | both experiments off | full/left/right/float | PTY → libghostty → HTML → Pi composite |
| **Exclusive** | `experimentalExclusiveFrame: true` + wrap + left/right | left/right only | PTY → libghostty → HTML → direct rect (Pi composite suppressed when leased) |
| **Takeover** | `experimentalTakeover: true` | forces full | PTY → raw VT to TTY (no libghostty/HTML/Pi) |

Takeover wins over exclusive (forces exclusive off).

## Atomic DEC 2026 frames (all embed/exclusive)

PTY bytes always feed libghostty. Publish (invalidate + requestFrame / exclusive direct paint) only when no synchronized frame is open (`ESC[?2026h` … `ESC[?2026l`). Partial chunks keep the previous complete snapshot.

## Toggle

```text
/hunk config right experimental-exclusive
/hunk config right no-exclusive
/hunk config full experimental-takeover
/hunk config right no-takeover
```

`/hunk status` reports both experiment flags.
