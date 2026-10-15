# statusline

A Claude Code status line: model, context window, and the 5-hour and 7-day
limits as dot bars, with the time until each limit resets.

```
opus  ctx ●●●●○○ 124k/200k  5h ●○○○○○ 2h14m  7d ●●○○○○ 3d4h
```

Dots turn yellow from 70 % and red from 90 %. Parts Claude Code doesn't report
(limits off a subscription, context before the first reply) are left out. When
the line is wider than the terminal, the limits move to a second line.

Needs bash and `jq`.

## Install

```
/plugin marketplace add zweihuehner/agentic
/plugin install statusline@agentic
/statusline:setup
```

Claude Code doesn't let a plugin set the status line, so `/statusline:setup`
does it: it shows the change to `~/.claude/settings.json` and saves it once you
agree. The setting points at the marketplace's copy of `statusline.sh`, so
`/plugin marketplace update` updates the line too. `scripts/bootstrap.sh` at
the repo root runs the same setup.

Without Claude: `bash setup.sh` prints the diff, `--apply` saves it.

## Remove

```
/statusline:setup remove
/plugin uninstall statusline@agentic
```

`remove` drops `statusLine` only if it still points at this script.
