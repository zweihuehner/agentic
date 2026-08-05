---
name: lightning-ai
description: >-
  Hands-on guide for doing research and development work on the Lightning AI platform:
  submitting and monitoring batch Jobs with lightning_sdk, choosing and pricing GPU
  machines, keeping credit spend under control, and laying out storage sensibly. Use
  this skill whenever the user mentions Lightning AI, lightning_sdk, Job.run, MMT,
  Studios, teamspaces, Lightning credits, /teamspace paths, or lightning.ai — and whenever
  GPU machine names (T4/L4/L40S/RTXP/A100/H100/H200/B200/DATA_PREP), interruptible or spot
  instances, or GPU cost come up in the context of a teamspace, Studio, job, or Lightning
  credits, even when they never say "Lightning" out loud. (Generic GPU questions with no
  Lightning context — comparing hardware specs, or work on another cloud — don't need it.) Also use it before writing or editing any script
  that submits compute jobs, whenever the user asks what a run will cost or how to
  spend less, and whenever a job fails, gets preempted, or its artifacts can't be found.
---

# Lightning AI buddy

Your job is to remove the manual, error-prone parts of running work on Lightning AI so
the user can stay on their research. That means: you pick and price the machine, you
write the launcher, you catch the traps before they cost money, and you keep the
teamspace tidy. The user should never have to remember whether `Machine.A10G` exists or
whether spot is cheaper this week.

Two things make this skill worth consulting rather than improvising:

1. **The platform's real numbers contradict the folklore.** "Spot is 50–80% cheaper" is
   false often enough to matter — on some machines spot costs *more* than on-demand.
   Always read live prices.
2. **Several failure modes cost money or hours and are invisible until submit time.**
   They're catalogued in `references/pitfalls.md`. Check them before you launch, not
   after.

## The loop

Nearly every request follows the same shape. Don't skip the pricing step — an unpriced
submit is how a job you expected to run on the cheapest GPU lands on the most expensive one.

```
[auth]  ->  orient  ->  design the job  ->  preflight (validate + price)  ->  CONFIRM  ->  submit  ->  monitor  ->  clean up
```

### 0. First run — is the SDK usable at all?

If this is a fresh machine, or anything fails in a way that smells like credentials, start
here rather than guessing:

```bash
python <skill>/scripts/lai.py auth
```

It checks the Python version and SDK install, reports which credential source is active,
and then proves it by making a real API call. Keys are masked in the output. When nothing
is set up it prints the exact click-path to the API key (**lightning.ai → your org
name/logo top-left → Global settings → API Keys**), the two `export` lines to paste, and
where to persist them.

**The failure mode worth knowing:** with no credentials the SDK doesn't raise — it opens a
browser and blocks. In a script, CI job, or agent session that's an unexplained hang, not
an error. `lai.py` checks up front and exits with a message instead. If the user reports
"it just hangs", suspect credentials first.

Two more things that bite: environment variables **override** the `lightning login`
credentials file, so a stale exported key silently defeats a fresh login. And credentials
identify *who* you are, not *where* to work — outside a Studio you also need to name the
teamspace and its owner. A teamspace belongs to an organization **or** to a user, so
personal teamspaces take `user=` and have no org at all: `Teamspace(name=..., org=...)`
or `Teamspace(name=..., user=...)`. Every `lai.py` command accepts `--teamspace` with
`--org` or `--user`.

Full setup and troubleshooting: `references/auth-and-setup.md`.

### 1. Orient

Once auth works, find out where you are:

```bash
python <skill>/scripts/lai.py whoami
```

This reports the teamspace, org, both the teamspace-default and the *effective* cloud
account, and how many jobs already exist. Inside a Studio, `Teamspace()` infers everything
from the environment.

### 2. Design the job

Ask yourself, in order:

- **Does this even need a Job?** Studios are for interactive work; Jobs are for batch and
  unattended work — data prep, training, sweeps, benchmarks, offline inference. A
  30-second script belongs in the Studio. Anything long-running, repeatable, or that you
  want a record of belongs in a Job, because Jobs are reproducible from code and don't
  keep a Studio (and its billing) awake.
- **Studio env or Docker image?** `studio=` reuses an existing Studio's environment —
  the fast path when the code already runs there. `image=` gives a clean, pinned
  environment. They're mutually exclusive; passing both or neither is an error.
  What decides it is often not convenience but **machine availability**: `studio=` also
  pins the job to the Studio's cloud account, and `cloud=` will not override that, so a
  machine that account doesn't sell is simply unreachable from that Studio (400 at submit;
  see `references/pitfalls.md`). When the machine is fixed — reproducing a baseline
  recorded on specific hardware, say — go `image=` and bootstrap the environment in the
  job command. `assets/bootstrap_job.py` does that end to end.
- **Where does the data live and where do artifacts go?** See §Storage below. Getting
  this wrong is the most common source of "my job ran but I can't find the output".

Write the launcher as a **script on disk**, not an inline `python -c`. Start from
`assets/launcher_template.py`. A script is re-runnable, diffable, and reviewable — which
is the whole reason to use Jobs over clicking around the UI.

### 3. Preflight — validate and price

```bash
python <skill>/scripts/lai.py preflight --name my_train --machine L4 --hours 3
```

This catches the traps mechanically: invalid machine name, name collision with an
existing job, spot-costs-more, absurd queue wait, missing `max_runtime` on an expensive
box. It prints a cost estimate, then exits non-zero **only on hard errors** — a bad
machine name, a name collision, or interruptible that's unavailable or costs more.
Queue length and a missing `max_runtime` are warnings and still exit 0, so read the
output rather than only checking `$?`.

Run it *before* showing the user a plan, so the numbers you quote are real.

### 4. Confirm before spending

**Always show the cost and wait for an explicit go-ahead before calling `Job.run`.** The
user opted into this deliberately. Present it plainly — shape below, numbers always from
a live `preflight`, never from this example:

```
  machine   L4 (lit-l4-1, 1 GPU, GCP)
  rate      $0.48/hr on-demand
            $0.73/hr interruptible   <-- spot is MORE expensive here, using on-demand
  est. 3h   ~$1.44
  queue     ~91s
  script    launch_train.py

  Submit? (y/n)
```

If the estimate is large, say so in words too ("that's several hours of an 8×H100 box —
worth double-checking the command first"). Don't editorialize on small numbers.

**Warn, then defer.** If the user asks for something the platform data says is a bad
idea — an 8×GPU box for a job that won't scale, on-demand H100 with a 17-day queue, spot
for an uncheckpointed 12-hour run — say so once, concretely, with the number that makes
the case. Then do what they asked if they confirm. They may know something you don't.

### 5. Monitor

```python
job.wait()            # blocks until terminal state
job.status            # Pending | Running | Completed | Failed | Stopping | Stopped
job.logs              # captured logs — TERMINAL JOBS ONLY, raises while Pending/Running
job.total_cost        # actual spend so far
job.link              # URL to the job in the UI
```

For long runs, don't sit in a blocking `job.wait()` inside a script the user is watching
— poll status, or hand back the `job.link` and let them watch it in the UI.

`job.logs` is a post-mortem, not a stream: reading it before the job reaches a terminal
state raises `RuntimeError`, so progress has to come from `job.status` (or the UI). Make
the job print whatever it needs to report — a metrics table, a diff — to stdout, and read
it out of `job.logs` once the job ends.

### 6. Clean up

Job artifacts count toward teamspace storage, and past ~100 jobs nobody can tell what's
still needed. After results are safely elsewhere:

```bash
python <skill>/scripts/lai.py jobs --status Completed     # review first
python <skill>/scripts/lai.py jobs --delete-completed     # asks before deleting
```

`jobs` inspects 50 jobs by default because each one costs an API call to price
(`--limit 0` for all). Deletion needs an interactive terminal — it refuses to prompt on a
pipe, so an unattended run can never delete by accident.

Never delete a job whose artifacts haven't been copied somewhere durable.

## Choosing a machine

**Start small and scale only on evidence.** T4 → L4 → L40S/RTXP → A100 → H100 → H200/B200.
Most research iterations fit comfortably on the cheap end, and the cheapest machine that
finishes in acceptable time wins.

**The catalogue is dynamic — always query it, never quote a remembered number.** Prices,
availability, and queue times vary by cloud account and provider and change over time;
out-of-capacity machines are filtered out server-side, so even the same account can return
a different list an hour later. No reference file here contains a price table on purpose.

```bash
python <skill>/scripts/lai.py prices                      # current account
python <skill>/scripts/lai.py prices --gpu                # GPU families only
python <skill>/scripts/lai.py prices --cloud-account X    # a specific account
python <skill>/scripts/lai.py compare --family H100       # across ALL accounts
```

Underneath, it's `ts.list_machines(cloud_account=None, machine=None)`, which yields
records carrying `cost`, `interruptible_cost`, `wait_time`, `interruptible_wait_time`,
`provider` and `slug`. Full access path in `references/cost-and-machines.md`.

Four things the live query tells you that a static table can't:

- **Whether interruptible is actually cheaper.** Deltas run from strongly negative to
  strongly positive — spot has been observed costing over 3× on-demand. `preflight`
  errors on negative cases.
- **Whether interruptible exists at all.** `interruptible_cost` of 0/None means *not
  offered*, not free — an easy way to recommend a phantom bargain.
- **Queue wait.** On-demand queues for scarce GPUs have run to *days* while spot ran to
  minutes. Then interruptible isn't a saving, it's the only way to get the hardware.
- **What this account actually sells.** The set differs per provider, omits enum members
  (L40S on some accounts) and includes machines with no enum member (TPUs).

### Cloud accounts select the provider

Machine availability is per cloud account, and an account *is* your GCP/AWS/Nebius/Lambda
selection. `ts.cloud_accounts` lists them; `compare` prices a family across all of them
and reports the cheapest per GPU count. Differences of 2× or more between accounts for
the same machine are routine, in both directions depending on family.

**Careful with the resolution order** — `list_machines()` uses the explicit
`cloud_account=` argument, else the `LIGHTNING_CLUSTER_ID` env var, else all accounts. It
does **not** use `teamspace.default_cloud_account`, so inside a Studio you may be pricing
a different account than you think. `lai.py whoami` prints both and flags the mismatch.

Before recommending a cheaper account, weigh the provider trade-off in §Studios: artifacts
are only visible from a Studio on the same provider.

**Multi-GPU only when the job scales.** Price is close to linear in GPU count — `_X_8` is
roughly 8× the hourly rate. It's worth it only if the job finishes ≳8× faster, or the
model genuinely doesn't fit otherwise. For a job that doesn't scale, 8 GPUs is 8× the
cost for the same wall-clock.

**Big data movement → `DATA_PREP*`**, not a GPU box. Those have the large disks; paying
GPU rates to move files is pure waste.

**Interruptible when the work is checkpointed or cheap to redo** — sweeps, short jobs,
anything that resumes. For a long uncheckpointed run, preemption means starting over, and
the savings evaporate on the first restart.

Details and the current price snapshot: `references/cost-and-machines.md`.

## Storage

The rule that drives everything: **total teamspace storage = Studios + Jobs + Data
drive**, billed past the free allowance. So keep bulk data *out* of Studios.

- **Data belongs in Lightning storage (`/teamspace/lightning_storage/`) or a cloud
  connection**, not in the Studio's home directory. Studios stuffed with data start
  slowly and are miserable to clean up.
- **Cloud connections are free from Lightning's side**, and AWS/GCS integrate well and
  usually beat native Lightning storage on price. Mount them into jobs with
  `path_mappings`.
- **Long-lived datasets** should live outside teamspaces entirely — a Datastore or a
  cloud connection.
- **Job artifacts accumulate.** Sweep them periodically (§6 above).

`artifacts_local` / `artifacts_remote` are deprecated — use `path_mappings`.

More: `references/storage.md`.

## Studios and providers

- `Studio.start()` / `.stop()` from the SDK; `switch_machine()` to resize. Set
  `auto_shutdown` so a forgotten Studio doesn't quietly bill overnight — an idle Studio
  costs the same as a busy one.
- **Keep all jobs on one cloud provider.** Job artifacts are visible from a Studio only
  when the Studio is on the same provider. Run jobs across GCP and AWS and you'll be
  flipping the base Studio back and forth to read your own outputs, and can't see both at
  once. Pick the provider your data is near and stay there.
- `reuse_snapshot=True` (the default) avoids re-uploading an unchanged Studio env on
  every submit. Leave it on unless the env changed and the job is picking up stale code.

## Traps to check before every submit

These are the ones that actually bite. Full explanations and fixes in
`references/pitfalls.md` — read it when writing or reviewing a launcher.

| Trap | What happens | Fix |
|---|---|---|
| `Machine.A10G` | `AttributeError` — A10G isn't in this SDK. Widely copy-pasted from old examples. | Use a real member; `scripts/lai.py prices` lists them |
| `Machine.from_str("TYPO")` | Returns the string silently, fails only at submit | Prefer enum attributes; `preflight` validates |
| Enum name your account doesn't sell | availability varies by account, e.g. `L40S` | `preflight` warns; `compare` finds it elsewhere |
| Reused job name in a loop | Names must be unique per teamspace — sweep dies after the first job | Suffix the name: `f"sweep-lr{lr}"` |
| `interruptible=True` assumed cheaper | Sometimes costs *more* than on-demand | `preflight` compares live |
| `interruptible_cost` of 0 | Means *not offered*, not free — job runs at full rate | `preflight` errors |
| Pricing the wrong account | `list_machines()` follows `LIGHTNING_CLUSTER_ID`, not the teamspace default | `whoami` flags the mismatch |
| No `max_runtime` | A hung job on an expensive box bills until someone notices | Set it, especially on A100/H100/B200 |
| Mixed cloud providers | Artifacts invisible from the base Studio | One provider per project |
| No credentials | SDK opens a browser and **hangs** instead of erroring | `lai.py auth` |
| Stale `LIGHTNING_API_KEY` export | Silently overrides a fresh `lightning login` | `unset`, or update it |
| `cloud_provider=` / `cloud_account=` | Deprecated | Use `cloud=` |

## Bundled resources

- `scripts/lai.py` — the workhorse: `auth`, `whoami`, `prices`, `compare`, `preflight`,
  `jobs`. Run `python scripts/lai.py --help`. Prefer it over writing throwaway SDK
  snippets; it already handles credential detection, teamspace inference, per-account
  machine resolution, the spot-availability quirks, and the validation rules.
- `references/auth-and-setup.md` — install, getting the API key, the three auth paths and
  their precedence, persisting credentials, troubleshooting table. Read when setting up
  from scratch or when anything smells like a credentials problem.
- `assets/launcher_template.py` — starting point for a job launcher, with the sweep
  naming and confirmation gate done correctly.
- `assets/bootstrap_job.py` — launcher for the `image=` path: the job installs its own
  toolchain, clones the repo (private ones included) and runs. Use it when `studio=` can't
  reach the machine you need, or when a pinned, from-scratch environment is the point.
- `references/sdk-api.md` — verified `Job.run` / `MMT.run` / `Teamspace` / `Studio` API
  surface, auth setup. Read before writing SDK calls from memory.
- `references/cost-and-machines.md` — machine families, right-sizing, live price snapshot.
- `references/storage.md` — data layout, `path_mappings`, cleanup.
- `references/pitfalls.md` — the trap list above, explained, with fixes.
