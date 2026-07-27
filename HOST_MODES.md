# Host modes (shipped on feat/host-modes-and-atomic-frames)

Host mode is **not** a config flag. It is derived from overlay layout (+ wrap for exclusive) via
`resolveOverlayHostMode`:

| Mode | Derived when | Layouts | Paint path |
| --- | --- | --- | --- |
| **Embed** | float, or left/right without wrap | left/right/float | PTY → libghostty → HTML → Pi composite |
| **Exclusive** | left/right + `experimentalPiWrap` | left/right only | PTY → libghostty → HTML → direct rect (Pi composite suppressed when leased) |
| **Takeover** | `layout: "full"` | full | PTY → raw VT to TTY (no libghostty/HTML/Pi) |

```ts
// full → takeover
// left/right + experimentalPiWrap → exclusive
// else → embed
resolveOverlayHostMode({ layout, experimentalPiWrap })
```

## Atomic DEC 2026 frames (all embed/exclusive)

PTY bytes always feed libghostty. Publish (invalidate + requestFrame / exclusive direct paint) only when no synchronized frame is open (`ESC[?2026h` … `ESC[?2026l`). Partial chunks keep the previous complete snapshot.

## Configure layout (host follows)

```text
/hunk config full                 # takeover
/hunk config right experimental-wrap   # exclusive (default for right)
/hunk config right no-wrap        # embed split
/hunk config float                # embed float
```

`/hunk status` reports `host=takeover|exclusive|embed`.
