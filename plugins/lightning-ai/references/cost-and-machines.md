# Cost and machine choice

## Never hardcode the catalogue

Machine availability and price are **not static**. They vary by cloud account, by
provider, by region, and over time — and the API filters out machines that are currently
out of capacity, so the same call can return a different list an hour later.

So this file deliberately contains **no price table**. Quote live numbers or none.

## How to access the machine list

The catalogue lives on the teamspace:

```python
from lightning_sdk import Teamspace
ts = Teamspace()   # inside a Studio; elsewhere export what `lai.py whoami` prints

for m in ts.list_machines():
    print(m.slug, m.family, m.accelerator_count,
          m.cost,                     # $/hr on-demand
          m.interruptible_cost,       # $/hr spot — 0 or None means NOT OFFERED
          m.wait_time,                # queue seconds, on-demand
          m.interruptible_wait_time,  # queue seconds, spot
          m.provider, m.instance_type)
```

Or from the shell, which is usually what you want:

```bash
python scripts/lai.py prices                    # current account
python scripts/lai.py prices --gpu              # GPU families only
python scripts/lai.py prices --json             # machine-readable
```

### Which cloud account does it read?

`list_machines(cloud_account=None, machine=None)` resolves in this order:

1. the explicit `cloud_account=` argument, else
2. the **`LIGHTNING_CLUSTER_ID` environment variable**, else
3. every global cloud account bound to the teamspace.

`teamspace.default_cloud_account` is **not** consulted. Inside a Studio,
`LIGHTNING_CLUSTER_ID` is set to that Studio's cluster, so it can differ from the
teamspace default and you'll be pricing something other than what you assumed.
`scripts/lai.py whoami` prints both and flags the mismatch.

### Listing per account, and across accounts

```python
ts.cloud_accounts                       # every account bound to the teamspace — use
                                        # these names, they differ per org
ts.list_machines(cloud_account="<your-account>")   # just that one
```

```bash
python scripts/lai.py prices --cloud-account <your-account>
python scripts/lai.py compare --family H100        # price it across every account
```

`compare` is the one to reach for before any long or expensive run. It queries each
account in turn (so it's slow), then reports the cheapest on-demand and cheapest spot
option per GPU count, with queue times.

Accounts map to providers — an account is how you select GCP vs AWS vs Nebius vs Lambda.
Some bound accounts return zero machines; that's normal, they're just not provisioned for
this teamspace.

## What's stable enough to reason about

Prices move; structure doesn't. These hold regardless of what the table says today.

**Families ranked by capability**, cheapest first: `CPU*` → `DATA_PREP*` → `T4*` → `L4*` →
`L40S*` / `RTXP_6000*` → `A100*` → `H100*` → `H200*` / `B200_X_8`. TPUs sit outside this
ladder and only exist on some providers.

**Multi-GPU is priced near-linearly.** On every account checked so far, `_X_8` costs
roughly 8× the single-GPU rate — worth re-verifying with `compare` on a new provider. So it pays off only above ~8× speedup, or when the model
genuinely won't fit otherwise. For embarrassingly parallel work — sweeps, benchmarks — N
single-GPU jobs beat one 8-GPU job.

**The enum is not the catalogue.** `Machine.L40S` exists in the SDK but isn't offered on
every account; TPUs are offered on some accounts with no enum member at all. Check
availability, don't assume it. See `pitfalls.md`.

## What you must check every time

**Is interruptible actually cheaper here?** Not reliably. Observed deltas have ranged from
**strongly negative to strongly positive** on the same teamspace — including machines
where spot costs several times on-demand. The "spot is 50–80% cheaper" rule of thumb does
not survive contact with the data. Compare `cost` against `interruptible_cost` for the
specific machine, every time.

**Is interruptible even offered?** `interruptible_cost` of `0` or `None` means *not
available*, not free. Treating it as free is how you accidentally recommend a machine at
its full on-demand rate — or pick a "cheapest" option that doesn't exist.

**What's the queue?** `wait_time` and `interruptible_wait_time` are independent, and the
gap can be enormous — on-demand queues measured in *days* against spot queues in minutes
for the same scarce GPU. When that happens, interruptible isn't a cost optimisation, it's
the only way to run this week, and the real question becomes "does this job checkpoint?"

**Is another account dramatically cheaper?** The same machine can differ by 2× or more
between providers, in either direction depending on the family. Run `compare` before
committing to a long run — but read the provider caveat below first.

## The provider trade-off

Cheaper on another account is not automatically better. Job artifacts are only visible
from a Studio on the **same provider**, so moving means switching your base Studio, and
you can't see both providers' artifacts at once.

Worth switching for: a long, expensive run where the saving is large; a machine family
your current provider doesn't offer; a queue that makes your provider unusable.

Not worth switching for: a marginal saving on a short job, or one experiment in a series
that otherwise lives on one provider. Consistency is worth real money in avoided
confusion.

## Right-sizing

Climb the ladder only on evidence:

- **CPU / DATA_PREP** — orchestration, preprocessing, anything I/O-bound. `DATA_PREP*`
  has the large disks; paying GPU rates to move files is pure waste.
- **T4 / L4** — small models, inference, debugging the training loop, short experiments.
  Most research iteration belongs here.
- **L40S / RTXP_6000** — the workhorse tier. Strong mid-range training, high VRAM. Often
  the best value per unit of capability, and frequently overlooked in the jump from L4
  straight to A100.
- **A100** — large-model training, when 40/80GB is the binding constraint.
- **H100** — when A100 throughput is measurably the bottleneck on a long production run.
- **H200 / B200** — top-end, largest models, and where mistakes cost the most.

Good reasons to move up: the model OOMs; you measured step time and the run won't finish
in time; the cheaper machine's queue is worse. Bad reasons: the run "feels slow"; a bigger
number seems safer.

## Reducing spend

- **Right-size first.** The biggest savings are almost always "this didn't need an A100",
  not spot discounts.
- **Interruptible where work is checkpointed** — sweeps, short jobs, resumable training —
  *after* verifying the discount is real for that machine.
- **`max_runtime` on everything.** Cheap insurance against a hang billing overnight.
- **Stop Studios, or set `auto_shutdown`.** An idle Studio bills like a busy one.
- **Kill doomed runs immediately** with `job.stop()`. Don't let a diverged run finish.
- **Delete old jobs** — artifacts count toward teamspace storage.
- **One teamspace per project**, cost control on, its own credits. Makes spend
  attributable and stops one project consuming another's budget.
- **Set a credit alert** so you hear about a runaway before the credits are gone.

## Estimating before committing

```bash
python scripts/lai.py preflight --name my_train --machine L4 --hours 3
```

For an unknown runtime, time one epoch or one batch on the cheapest machine that fits and
extrapolate. A ten-minute probe costing cents is a far better basis for an H100 decision
than any guess.
