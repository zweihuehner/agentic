# agentic

Personal agent tooling: [Claude Code](https://claude.com/claude-code) plugins
and the config that goes with them. The repo is a plugin marketplace named
`agentic`.

## Plugins

| Plugin | Type | What it does | Needs |
|---|---|---|---|
| [`lightning-ai`](plugins/lightning-ai/) | skill | Run, price and manage jobs on Lightning AI | Python ≥ 3.11, `lightning-sdk` |
| [`tasks-panel`](plugins/tasks-panel/) | mod | Pane with Claude's tasks, open decisions and the session goal | Claude Code ≥ 2.1.287, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` |

Skills are plain `SKILL.md` folders and also work in other harnesses that read
[Agent Skills](https://agentskills.io). Mods are Claude Code only.

## Install

Plugins only:

```
/plugin marketplace add zweihuehner/agentic
/plugin install <plugin>@agentic
```

Full setup on a machine (plugins, status line, settings, global git ignore):

```bash
git clone https://github.com/zweihuehner/agentic.git ~/dev/agentic
~/dev/agentic/scripts/bootstrap.sh lightning-ai tasks-panel
```

`bootstrap.sh` needs bash and `jq`, and is safe to rerun. From a clone the
marketplace is read in place: after an edit, run `/reload-plugins`.

To have a project offer a plugin to everyone who trusts it, add to its
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agentic": { "source": { "source": "github", "repo": "zweihuehner/agentic" } }
  },
  "enabledPlugins": { "lightning-ai@agentic": true }
}
```

## Layout

```
.claude-plugin/marketplace.json   one entry per plugin
plugins/<feature>/                one plugin per feature, with its own README
config/                           status line, settings snippet, git ignores
scripts/bootstrap.sh              sets up config/ and plugins on a machine
```

Plugins don't pin a `version`, so every push is a new version and nobody
misses a fix because of a forgotten bump. `claude plugin validate --strict`
flags this; plain `validate` passes.

## Licence

MIT
