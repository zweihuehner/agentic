#!/usr/bin/env python3
"""Job launcher for the `image=` path — the job builds its own environment.

Use this instead of `launcher_template.py` when:

- **The machine you need isn't on the Studio's cloud account.** `studio=` pins the job to
  that account and `cloud=` won't override it, so an L4 job from a Studio on an H100-only
  account fails at submit with `accelerator lit-l4-1 not found for this Lightning
  cluster`. An `image=` job is account-independent — pass whichever `cloud=` sells the
  machine. (See `references/pitfalls.md`.)
- **A pinned, from-scratch environment is the point** — reproducing a baseline, or proving
  the run doesn't depend on a Studio's accumulated state. This benchmarks a clean
  checkout, not your worktree; if you need uncommitted changes, push a branch first and
  set REF.

The trade is a few minutes of bootstrap per job (apt + uv + clone + sync) against not
having to keep a Studio in sync. On a short job that setup can dominate the bill — for
repeat runs on a machine the Studio *can* reach, `studio=` is cheaper.

Preflight it first:
    python <skill>/scripts/lai.py preflight --name my_job --machine L4 --hours 1 \
        --cloud-account <account>
"""

from __future__ import annotations

import subprocess
import sys

from lightning_sdk import Job, Machine, Teamspace

# --- CONFIG ---------------------------------------------------------------

NAME = "my_bootstrap_job"      # unique within the teamspace
MACHINE = Machine.L4
CLOUD = None                   # cloud ACCOUNT selling MACHINE; `lai.py compare --family L4`
INTERRUPTIBLE = False          # check `lai.py prices` — spot is not always cheaper
MAX_RUNTIME = 3 * 3600         # seconds; caps the bill if the job hangs
HOURS_EXPECTED = 1.0           # for the cost estimate only

# A plain slim image is enough for GPU work: Lightning mounts the host driver, so
# `nvidia-smi` and CUDA-enabled torch wheels work without a CUDA base image. Verified on
# python:3.11-slim + L4 (driver 580.173.02). Pin a CUDA image only if you need system CUDA
# libraries that the wheels don't vendor.
IMAGE = "python:3.11-slim"

REPO_URL = "https://github.com/OWNER/REPO"
REF = None                     # branch/tag/SHA; None = default branch
WORKDIR = "/work/repo"
RUN = "uv run pytest -q"       # the actual work

# Token for cloning. A private repo needs one — and so do private *dependencies*, which is
# the part people miss: the git-config rewrite below covers the repo and every
# git+https://github.com/... dep in one go. Prefer a teamspace secret over env= for
# anything longer-lived than a one-off.
GITHUB_TOKEN_CMD = ["gh", "auth", "token"]   # or read from a secret store
ENV = {}                       # extra env for the job

# --------------------------------------------------------------------------


def command():
    """The job's shell command: bootstrap -> code -> work.

    `set -eux` matters: without `-e` a failed clone or sync still runs the work step and
    the job fails with a confusing error; without `-x` the log doesn't show which step
    died.
    """
    steps = [
        "set -eux",
        # Log the GPU and free disk before anything can go wrong — between them they
        # explain most job failures after the fact, and neither is recoverable later.
        # nvidia-smi is absent if no driver is mounted; report that instead of dying, so
        # a CPU-only mistake shows up as a readable log line.
        "(nvidia-smi || echo 'NO nvidia-smi — no GPU visible')",
        "df -h /",
        "apt-get update -qq",
        "apt-get install -y -qq git curl ca-certificates",
        "curl -LsSf https://astral.sh/uv/install.sh | sh",
        'export PATH="$HOME/.local/bin:$PATH"',
        'git config --global url."https://x-access-token:'
        '${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"',
        f"git clone --depth 1 {REPO_URL} {WORKDIR}",
        f"cd {WORKDIR}",
    ]
    if REF:
        # --depth 1 fetched one commit; fetch the ref explicitly rather than assuming.
        steps.append(f"git fetch --depth 1 origin {REF} && git checkout {REF}")
    steps += [
        "git log --oneline -1",     # pin the log to an exact commit
        "uv sync",
        RUN,
    ]
    return " && ".join(steps)


def price(ts, machine, cloud_account=None):
    """Live rate for `machine`: match on slug, else exact family + GPU count.

    Same lookup as launcher_template.py — see the notes there on why a prefix family match
    (L4 -> L40S) and the 40GB/80GB and SMALL variants need care.
    """
    live = ts.list_machines(cloud_account=cloud_account) if cloud_account else ts.list_machines()
    for m in live:
        if m.slug == machine.slug:
            return m

    def norm(s):
        return "".join(c for c in s.upper() if c.isalnum())

    aliases = {"RTXPRO": "RTXP"}
    want = aliases.get(norm(machine.family), norm(machine.family))
    name = str(machine).upper()
    cands = [
        m
        for m in live
        if norm(m.family) == want
        and m.accelerator_count == machine.accelerator_count
        and m.cost
        and all(mem not in name or mem.lower() in m.slug.lower() for mem in ("40GB", "80GB"))
        and ("SMALL" in name) == ("small" in m.slug.lower())
    ]
    return min(cands, key=lambda m: m.cost) if cands else None


def main():
    ts = Teamspace()

    if NAME in {j.name for j in ts.jobs}:
        sys.exit(f"A job named '{NAME}' already exists. Names must be unique in the teamspace.")

    token = subprocess.run(
        GITHUB_TOKEN_CMD, capture_output=True, text=True, check=True
    ).stdout.strip()
    if not token:
        sys.exit("No GitHub token — private clones inside the job would hang or fail.")

    m = price(ts, MACHINE, CLOUD)
    if m is None:
        print(f"  WARNING   {MACHINE} isn't offered by this cloud account — check "
              f"`lai.py compare --family {MACHINE.family}`. Submitting may fail.")
    else:
        spot_ok = bool(m.interruptible_cost) and m.interruptible_cost > 0
        use_spot = INTERRUPTIBLE and spot_ok
        rate = m.interruptible_cost if use_spot else m.cost
        kind = "interruptible" if use_spot else "on-demand"

        print(f"  machine   {m.slug} ({m.accelerator_count} × {m.family}, {m.provider})")
        print(f"  account   {CLOUD or 'from LIGHTNING_CLUSTER_ID'}")
        print(f"  rate      ${rate:.2f}/hr {kind}")
        if use_spot and m.interruptible_cost > m.cost:
            print(f"  WARNING   spot costs MORE here (${m.cost:.2f}/hr on-demand). Reconsider.")
        print(f"  est {HOURS_EXPECTED:g}h  ~${rate * HOURS_EXPECTED:.2f}   "
              f"(cap {MAX_RUNTIME / 3600:g}h ~${rate * MAX_RUNTIME / 3600:.2f})")
        print(f"  image     {IMAGE}   +bootstrap (apt, uv, clone, sync)")

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
        command=command(),
        image=IMAGE,          # no studio= — that would pin the cloud account
        cloud=CLOUD,
        interruptible=INTERRUPTIBLE,
        max_runtime=MAX_RUNTIME,
        env={"GITHUB_TOKEN": token, **ENV},
    )
    print(f"\nsubmitted: {job.name}\n{job.link}")
    # Don't try to tail job.logs — it raises until the job is terminal. Poll status, then
    # read the log once at the end.
    return job


if __name__ == "__main__":
    main()
