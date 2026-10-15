# agentic

Personal agent tooling: [Claude Code](https://claude.com/claude-code) plugins
(skills, mods), and the config that goes with them. The repo is a plugin
marketplace named `agentic`.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/<feature>/                one installable plugin per feature
config/                           personal setup /plugin can't install
scripts/bootstrap.sh              sets up config/ and plugins on a machine
```

Plugins are grouped by feature, not by type: a plugin holds whatever it needs
(skills, hooks, a mod), and its marketplace `category` says what it is.

| Plugin | Category | What it does |
|---|---|---|
| [`lightning-ai`](plugins/lightning-ai/) | skill | Running research work on [Lightning AI](https://lightning.ai): authentication, batch Jobs via `lightning_sdk`, live machine pricing across cloud accounts, cost control, and storage layout. |
| [`tasks-panel`](plugins/tasks-panel/) | mod | A Claude Code pane with Claude's tasks, open decisions, and the session's goal. Claude Code only. |

Skills are plain `SKILL.md` folders, so they also work in other harnesses that
read the [Agent Skills](https://agentskills.io) format. Mods are Claude Code
only.

## Install

```
/plugin marketplace add zweihuehner/agentic
/plugin install lightning-ai@agentic
/plugin install tasks-panel@agentic
```

Refresh later with `/plugin marketplace update`. Plugin skills are namespaced,
so the skill is `/lightning-ai:lightning-ai`.

To set up a machine (status line, settings, global git ignore, marketplace and
plugins) from a clone:

```bash
git clone https://github.com/zweihuehner/agentic.git ~/dev/agentic
~/dev/agentic/scripts/bootstrap.sh                 # config + tasks-panel
~/dev/agentic/scripts/bootstrap.sh lightning-ai    # config + named plugins
```

From a clone the marketplace is read in place, so an edit takes effect with
`/reload-plugins`, with no reinstall.

A repository can require the marketplace for everyone who works in it, so
contributors are prompted to install on folder trust. In that repo's
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agentic": {
      "source": { "source": "github", "repo": "zweihuehner/agentic" }
    }
  },
  "enabledPlugins": { "lightning-ai@agentic": true }
}
```

No plugin here pins a `version`, so Claude Code falls back to the git commit
SHA and every push is a new version. That's deliberate: for skills that are
mostly documentation, a forgotten version bump means nobody ever receives the
correction. (`claude plugin validate --strict` flags this; plain `validate`
passes.)

### Or as a plain skill

Skills are also discovered from `~/.claude/skills/` (all projects) or
`<repo>/.claude/skills/` (one project). Symlink so updates land in both places:

```bash
mkdir -p ~/.claude/skills
ln -s ~/dev/agentic/plugins/lightning-ai ~/.claude/skills/lightning-ai
```

Restart Claude Code afterwards; skills are enumerated at startup. Because the
folder contains a `.claude-plugin/plugin.json`, a symlinked copy loads as a
plugin named `lightning-ai@skills-dir` rather than a bare skill. It works the
same; it just reports itself differently.

## lightning-ai

Grounded against `lightning_sdk` 2026.06.08 by querying a live teamspace, not by reading
docs. That matters: several widely circulated examples don't work.

The bundled `scripts/lai.py` is usable on its own, without Claude:

```bash
python plugins/lightning-ai/scripts/lai.py auth        # check credentials, print setup steps
python plugins/lightning-ai/scripts/lai.py whoami      # teamspace, cloud account, job count
python plugins/lightning-ai/scripts/lai.py prices      # live $/hr, spot delta, queue wait
python plugins/lightning-ai/scripts/lai.py compare --family H100   # across all cloud accounts
python plugins/lightning-ai/scripts/lai.py preflight --name train --machine L4 --hours 3
python plugins/lightning-ai/scripts/lai.py jobs        # list, spend, cleanup
```

It never submits a job. It prices and validates; submitting stays an explicit, confirmed
act.

### Some of what it catches

- **`Machine.A10G` doesn't exist** in current SDK versions, though it's all over older
  examples. `Machine.from_str()` accepts typos silently, so bad names survive to submit.
- **Interruptible is not reliably cheaper.** Observed deltas span from spot costing over
  3× on-demand to ~70% cheaper, on the same teamspace. The "spot is 50–80% cheaper" rule
  of thumb is not safe to apply.
- **`interruptible_cost` of 0 means unavailable, not free** — read naively it looks like
  the cheapest option on the board.
- **Queue wait can dominate price.** On-demand queues for scarce GPUs have run to *days*
  where spot ran to minutes; then interruptible is how you get the hardware, not how you
  save money.
- **`list_machines()` ignores `default_cloud_account`.** It follows `LIGHTNING_CLUSTER_ID`,
  so inside a Studio you can price a different account than you assume.
- **Job names must be unique per teamspace**, so a sweep looping over one name silently
  runs only its first job.

No price tables are committed anywhere in this repo — the catalogue varies by cloud
account and changes over time, so it's always queried.

## Licence

MIT
