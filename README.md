# claude-skills

Personal [Claude Code](https://claude.com/claude-code) skills.

A skill is a folder with a `SKILL.md` that Claude loads on demand when the task matches
its description. Anything in `scripts/`, `references/`, and `assets/` is pulled in only
when needed, so a large skill costs nothing until it's relevant.

## Skills

| Skill | What it does |
|---|---|
| [`lightning-ai/`](lightning-ai/) | Running research work on [Lightning AI](https://lightning.ai): authentication, submitting and monitoring batch Jobs via `lightning_sdk`, live machine pricing across cloud accounts, cost control, and storage layout. |

## Install

This repo is also a **plugin marketplace**, which is the way to install if you want
updates without maintaining a copy:

```
/plugin marketplace add zweihuehner/claude-skills
/plugin install lightning-ai@zweihuehner-skills
```

Refresh later with `/plugin marketplace update`. Plugin skills are namespaced, so the
skill is `/lightning-ai:lightning-ai`.

A repository can require the marketplace for everyone who works in it, so contributors
are prompted to install on folder trust rather than being told to go and clone something.
In that repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "zweihuehner-skills": {
      "source": { "source": "github", "repo": "zweihuehner/claude-skills" }
    }
  },
  "enabledPlugins": { "lightning-ai@zweihuehner-skills": true }
}
```

No plugin here pins a `version`, so Claude Code falls back to the git commit SHA and
every push is a new version. That's deliberate: for skills that are mostly documentation,
a forgotten version bump means nobody ever receives the correction.

### Or as a plain skill

Skills are also discovered from `~/.claude/skills/` (all projects) or
`<repo>/.claude/skills/` (one project). Symlink so updates land in both places:

```bash
git clone git@github.com:zweihuehner/claude-skills.git ~/src/claude-skills
mkdir -p ~/.claude/skills
ln -s ~/src/claude-skills/lightning-ai ~/.claude/skills/lightning-ai
```

Restart Claude Code afterwards — skills are enumerated at startup. Note that because
`lightning-ai/` now contains a `.claude-plugin/plugin.json`, a symlinked copy loads as a
plugin named `lightning-ai@skills-dir` rather than a bare skill. It works the same; it
just reports itself differently.

## lightning-ai

Grounded against `lightning_sdk` 2026.06.08 by querying a live teamspace, not by reading
docs. That matters: several widely circulated examples don't work.

The bundled `scripts/lai.py` is usable on its own, without Claude:

```bash
python lightning-ai/scripts/lai.py auth        # check credentials, print setup steps
python lightning-ai/scripts/lai.py whoami      # teamspace, cloud account, job count
python lightning-ai/scripts/lai.py prices      # live $/hr, spot delta, queue wait
python lightning-ai/scripts/lai.py compare --family H100   # across all cloud accounts
python lightning-ai/scripts/lai.py preflight --name train --machine L4 --hours 3
python lightning-ai/scripts/lai.py jobs        # list, spend, cleanup
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
