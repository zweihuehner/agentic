# tasks-panel

A Claude Code mod (tested with v2.1.300) that shows a **tasks** pane: Claude's
tasks, open decisions, and the session's goal. It is Claude Code only: mods
have no equivalent in other harnesses.

## What it does

- Mirrors `TaskCreate` / `TaskUpdate` / `TaskList` calls into a pane. The pane
  opens by itself on the first task or decision; `/tasks-panel` toggles it.
- Shows decisions under **decide**. A decision is a task whose subject starts
  with `decide:`, a pending `AskUserQuestion` call, or a top-level bullet under
  `## Open questions` in the plan file (ticked `[x]` bullets are answered).
- Reads the goal from this session's plan file,
  `<project root>/.claude/plans/<session name or id>.md`. The name counts only
  when you gave it (`-n`, `/rename`). A session claims its file while it runs,
  so a second live session with the same name gets `<name>-<short id>.md`.
- Injects short rules into the system prompt, so they survive `/compact` and
  disappear when the mod is off. No CLAUDE.md is written.

It needs `"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"` in the `env` block of
`~/.claude/settings.json` so the task tools are active. `scripts/bootstrap.sh`
at the repo root sets it.

Subagents don't get the task tools, so `· agent` shows on a task when it has
an owner (or a subagent did touch it). Ask Claude to set the owner when it
delegates.

## Install

```
claude plugin marketplace add zweihuehner/agentic   # or a local clone's path
claude plugin install tasks-panel@agentic --scope user
```

Installed from a local clone, it is read straight from the folder: after an
edit, run `/reload-plugins` in an open session.

## Develop

```
claude plugin validate plugins/tasks-panel
cd plugins/tasks-panel && claude plugin test
```

`validate --strict` fails only on the missing `version`, which this repo leaves
out on purpose (see the root README).

## Disable

```
claude plugin disable tasks-panel@agentic
```

Or use `/plugin` → Installed. `claude plugin enable tasks-panel@agentic` turns
it back on.

## Uninstall

```
claude plugin uninstall tasks-panel@agentic
```

That removes its `enabledPlugins` entry from `~/.claude/settings.json`
(leaving an empty `"enabledPlugins": {}` if it was the only one). Run
`claude plugin marketplace remove agentic` too if nothing else from this repo
is installed.

These stay behind; delete them by hand if you want them gone:

- `~/.claude/plugins/store/tasks-panel_*.json`: one record per session (tasks,
  plan path, whether the pane auto-opened). While the mod runs it deletes
  records not touched for 30 days. Store files from `--plugin-dir` runs
  (`tasks-panel_inline-*.json`) are never pruned.
- `~/.claude/plugins/cache/agentic/tasks-panel/`: an unused install-time copy,
  which Claude Code marks orphaned on uninstall.
- `.claude/plans/*.md` in each project you used it in.
- `CLAUDE_CODE_ENABLE_TODO_TOOLS` in `~/.claude/settings.json`.
