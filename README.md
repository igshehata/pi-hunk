<p align="center">
  <img src="assets/hero.svg" alt="pi-hunk — review in Hunk, return with context" width="1000" />
</p>

# pi-hunk

Review your agent's changes in [Hunk](https://hunk.dev) without leaving
[Pi](https://github.com/earendil-works/pi) or [Oh My Pi](https://omp.sh). Leave comments and the
agent gets them.

## Install

You need Node.js 22.19+ and [Hunk](https://hunk.dev) 0.25.0+ on your `PATH`.

```sh
omp plugin install pi-hunk   # Oh My Pi
pi install npm:pi-hunk       # Pi
```

Restart your agent afterwards.

## Use

Press <kbd>Ctrl</kbd> + <kbd>Space</kbd>, let go, then press:

| Key          | Opens                                  |
| ------------ | -------------------------------------- |
| <kbd>h</kbd> | Uncommitted changes                    |
| <kbd>s</kbd> | Latest commit                          |
| <kbd>l</kbd> | Commit history                         |
| <kbd>b</kbd> | Everything on your branch since `main` |
| <kbd>c</kbd> | The whole codebase                     |

1. Comment on lines with Hunk's usual keys.
2. Press <kbd>q</kbd> to close Hunk. Your saved comments go to the agent.

In history, select commits and press <kbd>Enter</kbd> to review them. <kbd>q</kbd> takes you back to
the list; quit the list to send everything.

Only saved comments are sent. Closing Hunk with no comments sends nothing.

## Hunk beside the agent

In Tern, Rex, or Herdr, set the mode to `multiplexer` in `/hunk config`. Hunk then opens in a pane
next to the agent, and each comment goes to the agent as soon as you save it. Press <kbd>r</kbd> in
Hunk to see the agent's latest changes.

## Configure

Run `/hunk config` to change the keys, the mode, or what happens if the agent is busy when your
comments arrive:

| Setting           | Your comments...                    |
| ----------------- | ----------------------------------- |
| `steer` (default) | join the turn that's running        |
| `followUp`        | wait until the turn finishes        |
| `interrupt`       | stop the turn and are sent straight |

If your main branch isn't `main` or `master`, add `"base": "develop"` (for example) to
`~/.omp/agent/pi-hunk.json` or `~/.pi/agent/pi-hunk.json`.

If your OS already uses <kbd>Ctrl</kbd> + <kbd>Space</kbd>, pick another prefix.

To tell the agent how to handle your reviews, put it in `AGENTS.md` or a skill.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
