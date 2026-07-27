# same-tab takeover

Takeover is the host mode for `overlay.layout: "full"`. It is derived by `resolveOverlayHostMode` —
not a separate config flag.

Enable: `/hunk config full`  
Disable: `/hunk config right` (or left/float)

Behavior: Hunk PTY bytes write to real TTY; Pi requestRender no-op while active; leave restores alt
screen + force Pi redraw.
