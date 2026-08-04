#!/usr/bin/env python3
"""Job launcher template — copy, edit the CONFIG block, run.

Why a script instead of an inline snippet: it is re-runnable, diffable, and reviewable.
That reproducibility is the main reason to use Jobs rather than clicking in the UI.

Before running, preflight it:
    python <skill>/scripts/lai.py preflight --name my_train --machine L4 --hours 3
"""

from __future__ import annotations

import sys

from lightning_sdk import Job, Machine, Teamspace

# --- CONFIG ---------------------------------------------------------------

NAME = "my_train"          # must be unique within the teamspace
MACHINE = Machine.L4       # verify with `lai.py prices`; Machine.A10G does not exist
COMMAND = "python main.py"
INTERRUPTIBLE = False      # check `lai.py prices` first — spot is not always cheaper
MAX_RUNTIME = 6 * 3600     # seconds; caps the bill if the job hangs
HOURS_EXPECTED = 3.0       # only used for the cost estimate below
CLOUD = None               # cloud account/provider, e.g. "lightning-public-prod".
                           # None = the account LIGHTNING_CLUSTER_ID points at.
                           # Compare accounts first: `lai.py compare --family <FAM>`

# Exactly one of these — they are mutually exclusive.
STUDIO = "my-studio"       # reuse a Studio's environment
IMAGE = None               # or pin a docker image, e.g. "python:3.11-slim"

ENV = {}                   # e.g. {"WANDB_API_KEY": "..."} — prefer teamspace secrets
PATH_MAPPINGS = {}         # mount cloud connections, e.g. {"/data": "s3://bucket/path"}

# --------------------------------------------------------------------------


def price(ts, machine, cloud_account=None):
    """Look up the live rate so the estimate reflects reality, not a stale table.

    The enum member carries a `slug` but null `cost`/`instance_type` — only the records
    from list_machines() have live pricing. Slug usually matches, but generic aliases
    don't: Machine.A100_X_8 is slug 'lit-a100-8' while an account may only offer
    'lit-a100-80gb-8'. So fall back to family + GPU count, taking the cheapest match.

    Note list_machines() resolves the account from cloud_account, else the
    LIGHTNING_CLUSTER_ID env var — never from teamspace.default_cloud_account.
    """
    live = ts.list_machines(cloud_account=cloud_account) if cloud_account else ts.list_machines()
    for m in live:
        if m.slug == machine.slug:
            return m

    # Fall back on family + GPU count, but match the family EXACTLY. A prefix match would
    # let a request for L4 resolve to an L40S — different GPU, several times the price —
    # and quoting hardware the user didn't ask for is worse than admitting no match.
    def norm(s):
        return "".join(c for c in s.upper() if c.isalnum())

    aliases = {"RTXPRO": "RTXP"}  # the one enum/live family string that differs
    want = aliases.get(norm(machine.family), norm(machine.family))
    name = str(machine).upper()
    cands = [
        m
        for m in live
        if norm(m.family) == want
        and m.accelerator_count == machine.accelerator_count
        and m.cost
        # A100_40GB vs A100_80GB, and T4 vs T4_SMALL, share a family and GPU count.
        and all(mem not in name or mem.lower() in m.slug.lower() for mem in ("40GB", "80GB"))
        and ("SMALL" in name) == ("small" in m.slug.lower())
    ]
    return min(cands, key=lambda m: m.cost) if cands else None


def main():
    ts = Teamspace()

    if (STUDIO is None) == (IMAGE is None):
        sys.exit("Set exactly one of STUDIO or IMAGE — they are mutually exclusive.")

    if NAME in {j.name for j in ts.jobs}:
        sys.exit(f"A job named '{NAME}' already exists. Names must be unique in the teamspace.")

    m = price(ts, MACHINE, CLOUD)
    if m is None:
        print(f"  WARNING   {MACHINE} isn't offered by this cloud account — check "
              f"`lai.py compare --family {MACHINE.family}`. Submitting may fail.")
    else:
        # A 0/None interruptible_cost means spot is NOT OFFERED, not free. Billing it as
        # free would understate the estimate by the entire cost of the job.
        spot_ok = bool(m.interruptible_cost) and m.interruptible_cost > 0
        use_spot = INTERRUPTIBLE and spot_ok
        rate = m.interruptible_cost if use_spot else m.cost
        kind = "interruptible" if use_spot else "on-demand"
        wait = m.interruptible_wait_time if use_spot else m.wait_time

        print(f"  machine   {m.slug} ({m.accelerator_count} × {m.family}, {m.provider})")
        print(f"  rate      ${rate:.2f}/hr {kind}")
        if INTERRUPTIBLE and not spot_ok:
            print(f"  WARNING   interruptible not offered here — this will run on-demand "
                  f"at ${m.cost:.2f}/hr.")
        elif use_spot and m.interruptible_cost > m.cost:
            print(f"  WARNING   spot costs MORE here (${m.cost:.2f}/hr on-demand). Reconsider.")
        if wait and wait > 3600:
            print(f"  WARNING   queue for this machine is ~{wait / 3600:.1f}h.")
        print(f"  est {HOURS_EXPECTED:g}h  ~${rate * HOURS_EXPECTED:.2f}")

    # Require a real terminal. On a pipe, a stray buffered "y" would count as consent to
    # spend money, and closed stdin would raise EOFError instead of aborting cleanly.
    if not sys.stdin.isatty():
        sys.exit("Refusing to submit: stdin is not a terminal. Run this interactively.")
    try:
        if input("\nSubmit? (y/n) ").strip().lower() != "y":
            sys.exit("Aborted — nothing submitted.")
    except (EOFError, KeyboardInterrupt):
        sys.exit("\nAborted — nothing submitted.")

    job = Job.run(
        name=NAME,
        machine=MACHINE,
        command=COMMAND,
        studio=STUDIO,
        image=IMAGE,
        cloud=CLOUD,
        interruptible=INTERRUPTIBLE,
        max_runtime=MAX_RUNTIME,
        env=ENV or None,
        path_mappings=PATH_MAPPINGS or None,
    )
    print(f"\nsubmitted: {job.name}\n{job.link}")
    return job


# --- Sweep variant --------------------------------------------------------
# The single most common mistake: reusing one name across loop iterations. Names must be
# unique per teamspace, so the second submit fails and the sweep silently runs one job.
#
#   for lr in ("0.01", "0.02", "0.03"):
#       Job.run(
#           name=f"sweep-lr{lr.replace('.', '')}",   # <-- unique per run
#           command=f"python main.py --lr {lr}",
#           machine=Machine.L4,
#           studio=STUDIO,
#           interruptible=True,      # sweeps are the ideal spot workload: short, re-runnable
#           max_runtime=3600,
#       )
#
# For one job spanning several machines, use MMT.run(..., num_machines=N) instead of a
# loop — that is distributed training, not N independent jobs.


if __name__ == "__main__":
    main()
