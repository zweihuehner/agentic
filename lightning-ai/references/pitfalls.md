# Pitfalls

Every entry here was verified against `lightning_sdk` 2026.06.08 on a live teamspace.
These are the failures that cost money or hours, and most of them are invisible until
submit time. `scripts/lai.py preflight` checks the mechanical ones for you.

## `Machine.A10G` does not exist

```python
>>> Machine.A10G
AttributeError: type object 'Machine' has no attribute 'A10G'
```

A10G appears throughout older Lightning examples and copy-pasted launcher scripts, so it
propagates easily. It is not in the current enum. The 55 real members are the CPU,
DATA_PREP, T4, L4, L40S, RTXP_6000, A100, H100, H200 and B200 families — `lai.py prices`
shows what your cloud account actually offers.

**Fix:** pick a real machine. For the "cheap general GPU" role A10G used to play, `L4` or
`T4` is the modern answer — price them with `lai.py prices --family L4`.

## `Machine.from_str()` swallows typos

```python
>>> Machine.from_str("A10G")
A10G                      # no error — returns the string
>>> Machine.A10G
AttributeError            # the attribute form catches it
```

`from_str` does not validate, so a typo passes every local check and only fails when the
job is submitted — after you've told the user it's ready.

**Fix:** use attribute access (`Machine.L4`) in launchers. If a name must come from a
string (config file, CLI arg), validate it against `dir(Machine)` first — that's what
`preflight` does.

## The `Machine` enum is not the same as what your account sells

Three separate mismatches, all of which look like your code is fine until submit time:

**Enum members your account doesn't offer.** `Machine.L40S` is a perfectly valid SDK name,
but some accounts return no L40S at all while others offer several variants. The enum
describes the SDK, not your entitlement — and the answer differs per cloud account, so
"it's not available" is always account-scoped. Check with
`lai.py compare --family L40S` before concluding it's gone.

**Machines your account sells that have no enum member.** TPUs (`lit-tpu-v6e-8`,
`lit-tpu-v5p-8`) show up in `list_machines()` with real prices on providers that have
them, but there's no `Machine.TPU_*`.

**Generic aliases point at slugs that don't exist.** `Machine.A100_X_8` carries
`slug='lit-a100-8'`, while an account may only offer the memory-qualified
`lit-a100-80gb-8` (or `lit-a100-40gb-8` elsewhere). A naive slug lookup misses it:

```python
>>> Machine.A100_X_8.slug
'lit-a100-8'                    # generic alias
>>> [m.slug for m in ts.list_machines() if m.family == 'A100']
['lit-a100-80gb-1', ..., 'lit-a100-80gb-8']    # what actually exists here
```

Also note the enum member has `cost=None` and `instance_type=None` — only the records
from `list_machines()` carry live pricing. And the family strings differ between the two:
the enum says `'RTX PRO'` where the live list says `'RTXP'`, and `DATA_PREP` (enum and
docs) is `'DATA-PREP'` in `m.family`. A hand-written `m.family == "DATA_PREP"` filter
silently matches nothing.

**Fix:** match enum → live record on `slug` first, then fall back to an **exact** family
match plus `accelerator_count`. Do *not* prefix-match families: `'L40S'.startswith('L4')`,
so a prefix fallback resolves a request for an L4 to an L40S — a different GPU at several
times the price, with no error. Variants that share a family and GPU count need the same
care: `A100_40GB` vs `A100_80GB`, and `T4` vs `T4_SMALL`, are distinguished only by a
token in the slug. `scripts/lai.py` and `assets/launcher_template.py` handle all of this;
reuse them rather than rewriting the lookup. When nothing matches exactly, `preflight`
warns rather than guessing.

## Job names must be unique within the teamspace

This one quietly breaks sweeps. The pattern circulating in examples:

```python
for lr in ['0.01', '0.02', '0.03']:
    Job.run(command=f"python main.py --lr {lr}", name="my-sweep-1", machine=...)
```

All three jobs share `name="my-sweep-1"`. The first succeeds; the rest collide. You get
one job, not three, and unless you're reading return values it looks like the sweep ran.

**Fix:** make the name a function of the varying parameter.

```python
name=f"sweep-lr{lr.replace('.', '')}"
```

Same applies to the benchmark-across-machines pattern — suffix with the machine name.

## Interruptible is not always cheaper

The "spot is 50–80% cheaper" rule of thumb is wrong often enough to matter. On a single
teamspace, measured spot deltas have spanned from **strongly negative to strongly
positive** — including variants where spot cost several times on-demand, and mid-range
GPUs where spot was quietly more expensive. Don't memorise those multiples either; the
only reliable number is the one `prices` shows you right now.

Setting `interruptible=True` reflexively can therefore cost you more *and* add preemption
risk for nothing.

**Fix:** compare `cost` against `interruptible_cost` for that exact machine at decision
time — `scripts/lai.py prices` flags negative deltas in red, and `preflight` errors on
them. Never carry a remembered percentage from one machine or account to another.

## `interruptible_cost` of 0 means unavailable, not free

Some accounts report `interruptible_cost` as `0` or `None` for machines that simply don't
offer spot. Read naively, that looks like the cheapest option on the board.

**Fix:** treat falsy `interruptible_cost` as "no spot offered" and fall back to `cost`.
Both bundled scripts do this; `preflight` errors if you request `interruptible=True` on
such a machine, because the job will silently run at the full on-demand rate.

## Queue wait is the hidden cost

`wait_time` and `interruptible_wait_time` are independent fields, and the gap can be
enormous — on-demand queues measured in **days** against spot queues in **minutes** for
the same scarce GPU. A machine can be nominally available and practically unobtainable.

When that happens, interruptible isn't a cost optimisation — it's the difference between
running today and running in three weeks, and the real question becomes "does this job
checkpoint?" rather than "can I afford on-demand?".

**Fix:** check both wait fields before promising a turnaround time. `prices` prints them;
`preflight` warns when the on-demand queue exceeds an hour.

## Multi-GPU pricing is linear; speedup usually isn't

On every account checked so far, `_X_8` costs roughly **8×** the single-GPU rate. Unless
the job scales near-linearly, 8 GPUs buys the same wall-clock at 8× the price — verify the
ratio with `compare` before relying on it on a new provider.

**Fix:** reach for `_X_8` only when the model doesn't fit otherwise, or you've measured
the scaling. For sweeps, N independent single-GPU jobs beat one 8-GPU job.

## `list_machines()` ignores `default_cloud_account`

This one silently prices the wrong thing. The resolution order is:

1. the explicit `cloud_account=` argument, else
2. the **`LIGHTNING_CLUSTER_ID`** environment variable, else
3. all global accounts bound to the teamspace.

`teamspace.default_cloud_account` is never consulted. Inside a Studio,
`LIGHTNING_CLUSTER_ID` is that Studio's cluster, so the two routinely disagree — example
`whoami` output, your account names will differ:

```
teamspace default cloud account  <account-a>   (AWS)
machine lookups resolve to       <account-b>   (GCP)
```

Quote a price from one while submitting against the other and the estimate can be off by
a factor of two or more — the same family is priced very differently per provider.

**Fix:** run `scripts/lai.py whoami`, which prints both and flags the mismatch. Pass
`--cloud-account` explicitly whenever it matters.

## A personal teamspace addressed with `user=` breaks `list_machines()` (older SDKs)

Lightning backs every personal teamspace with an auto-created organization, observed as
**`<username>-org`**. The same teamspace is therefore reachable two ways, with the same
id:

```python
Teamspace(name="<teamspace>", user="<username>")       # owner=User(...),         _org is None
Teamspace(name="<teamspace>", org="<username>-org")    # owner=Organization(...), _org is set
```

On older SDKs (seen on 2026.04.23) `Teamspace.list_machines()` ends with
`org_id=self._org.id`, so the `user=` form raises
`AttributeError: 'NoneType' object has no attribute 'id'`. Pricing, `preflight`, and
anything else that enumerates machines fail — while `whoami`, `ts.jobs`, and plain auth
all work fine, which makes it look like a pricing outage rather than an addressing
problem. Membership listings show *both* owners, so the `user=` spelling looks equally
legitimate. Newer SDKs (2026.10.13) pass `org_id=None` safely, and also deprecate
`org=`/`user=` in favour of `name="owner/teamspace"`.

**Fix:** nothing to do when going through `lai.py` — it lists reachable teamspaces from the
credentials and always resolves to the org-owned object. In your own code, take the
teamspace from `org.teamspaces` for one of `_get_authed_user().organizations` rather than
constructing it from a username. If you are stuck with a `user=`-constructed object on an
old SDK, call the underlying API directly with `org_id=None`:

```python
accts = [c.id for c in ts._cloud_account_api.list_global_cloud_accounts(teamspace_id=ts.id)]
cms = ts._teamspace_api.list_machines(ts.id, cloud_accounts=accts, machine=None, org_id=None)
```

## Missing `max_runtime`

A job that hangs — deadlocked dataloader, a wait on input that never arrives — bills
until a human notices. On a scarce multi-GPU box the bill adds up fast — take the live
on-demand rate from `prices` and multiply by however many hours it could run unspotted.

**Fix:** always pass `max_runtime` (seconds). Set it to a generous multiple of the
expected runtime, not a tight bound.

## Mixed cloud providers hide your artifacts

Job artifacts are reachable from a Studio only when the Studio sits on the same cloud
provider. Run some jobs on GCP and others on AWS and you'll be switching the base Studio
back and forth to read your own outputs — and can't see both sets at once.

**Fix:** pick one provider per project and stay on it. Choose the one your data is
already near.

## Deprecated parameters still accepted

These work but are on the way out, and they appear in most existing examples:

| deprecated | use instead |
|---|---|
| `cloud_provider=` | `cloud=` |
| `cloud_account=` | `cloud=` |
| `artifacts_local=` | `path_mappings=` |
| `artifacts_remote=` | `path_mappings=` |

## `studio=` and `image=` are mutually exclusive

Passing both is an error; passing neither falls back to the teamspace default env, which
is rarely what someone intends when they were explicit about everything else. Decide
consciously: `studio=` for "it already runs in my Studio", `image=` for a pinned,
reproducible environment.

## Stale snapshots

`reuse_snapshot=True` is the default and avoids re-uploading an unchanged Studio
environment on every submit. The failure mode: you change code in the Studio, submit, and
the job runs the old version.

**Fix:** if a job's behaviour doesn't match the code you just edited, suspect the
snapshot before suspecting the code.
