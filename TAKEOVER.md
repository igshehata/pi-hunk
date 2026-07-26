# experiment: same-tab takeover

Branch: experiment/same-tab-takeover
Worktree: pi-hunk.experiment-same-tab-takeover

Enable: overlay.experimentalTakeover=true or `/hunk config full experimental-takeover`
Disable: `/hunk config right no-takeover`

Behavior: Hunk PTY bytes write to real TTY; Pi requestRender no-op while active; leave restores alt screen + force Pi redraw.
