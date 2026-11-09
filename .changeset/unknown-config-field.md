---
"pi-hunk": patch
---

Keep Hunk working with a configuration a different build wrote: an unknown field is reported by name
and ignored while the known settings apply, and a file that cannot be parsed no longer makes
`/hunk config` fail — the startup notice names the file, the error, and the next step, and the menu
opens from defaults so Save can replace the broken file (Cancel leaves it untouched).
