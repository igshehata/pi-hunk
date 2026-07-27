# Host modes (shipped on feat/host-modes-and-atomic-frames)

Host mode is **not** a config flag. It is derived from overlay layout via `resolveOverlayHostMode`:

| Mode          | Derived when                   | Layouts         | Paint path                                                                                                              |
| ------------- | ------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Embed**     | `layout: "float"`              | float           | PTY → libghostty → HTML → Pi composite                                                                                  |
| **Exclusive** | `layout: "left"` or `"right"`  | left/right only | PTY → libghostty → HTML → direct rect (Pi composite suppressed when leased); Pi always wraps into the remaining columns |
| **Takeover**  | `layout: "full"` (**default**) | full            | PTY → raw VT to TTY (no libghostty/HTML/Pi)                                                                             |

```ts
// full → takeover (shipped default)
// left/right → exclusive (Pi wrap always on)
// float → embed
resolveOverlayHostMode({ layout });
```

## Atomic DEC 2026 frames (all embed/exclusive)

PTY bytes always feed libghostty. Publish (invalidate + requestFrame / exclusive direct paint) only
when no synchronized frame is open (`ESC[?2026h` … `ESC[?2026l`). Partial chunks keep the previous
complete snapshot.

## Configure layout (host follows)

```text
/hunk config full                 # takeover (default)
/hunk config right                # exclusive split (Pi wraps automatically)
/hunk config left                 # exclusive split (Pi wraps automatically)
/hunk config float                # embed float
```

`/hunk status` reports `host=takeover|exclusive|embed`.
