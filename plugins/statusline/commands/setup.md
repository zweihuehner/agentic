---
description: Point Claude Code's status line at this plugin's script
argument-hint: "[remove]"
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/setup.sh:*)
---

Set up the `statusline` plugin's status line. Arguments: "$ARGUMENTS".

1. Run `bash ${CLAUDE_PLUGIN_ROOT}/setup.sh` (add `--remove` if the arguments
   say remove). It changes nothing and prints the settings diff.
2. Show the user that diff as it is and ask whether to save it. If the script
   says the settings are already up to date, or it fails, say so and stop.
3. Only after they agree, run it again with `--apply` (or `--remove`) and tell
   them the status line updates within a few seconds; no restart is needed.

Don't edit `settings.json` yourself; the script does it and keeps a backup.
