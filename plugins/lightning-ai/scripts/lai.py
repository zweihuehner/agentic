#!/usr/bin/env python3
"""Lightning AI helper: orientation, live pricing, job preflight, and housekeeping.

Every subcommand is read-only except `jobs --delete-completed`, which asks first.
Nothing here submits a job — submitting stays an explicit, confirmed act.

    python lai.py auth            # start here if nothing works yet
    python lai.py whoami
    python lai.py prices [--gpu] [--family L4] [--cloud-account X] [--json]
    python lai.py compare --family H100 [--json]
    python lai.py preflight --name my_train --machine L4 [--hours 3] [--interruptible]
    python lai.py jobs [--status Completed] [--delete-completed]

Machine availability and price are per cloud account, and the catalogue changes as
capacity moves — out-of-capacity machines are filtered out server-side. Always query;
never quote a remembered number.
"""

from __future__ import annotations

import argparse
import os
import sys

# --- presentation helpers -------------------------------------------------

_TTY = sys.stdout.isatty()

# Output carries a few non-ASCII characters (×, …, —). On a legacy Windows codepage or
# under PYTHONIOENCODING=ascii those raise UnicodeEncodeError mid-print, which would lose
# the very warning the user needed to read. Degrade the character rather than the message.
try:
    sys.stdout.reconfigure(errors="replace")
except (AttributeError, OSError):  # pragma: no cover - older Python or odd stream
    pass


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s


def bold(s):
    return _c("1", s)


def red(s):
    return _c("31", s)


def yellow(s):
    return _c("33", s)


def green(s):
    return _c("32", s)


def dim(s):
    return _c("2", s)


class Findings:
    """Collects preflight problems so we can exit with a meaningful status."""

    def __init__(self):
        self.errors, self.warnings, self.notes = [], [], []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def note(self, msg):
        self.notes.append(msg)

    def render(self) -> int:
        for m in self.errors:
            print(f"  {red('ERROR')}  {m}")
        for m in self.warnings:
            print(f"  {yellow('WARN')}   {m}")
        for m in self.notes:
            print(f"  {dim('note')}   {m}")
        print()
        if self.errors:
            print(red("Preflight failed — fix the errors above before submitting."))
            return 1
        if self.warnings:
            print(yellow("Preflight passed with warnings — read them, then confirm with the user."))
            return 0
        print(green("Preflight clean."))
        return 0


# --- auth -----------------------------------------------------------------

WHERE_TO_GET_KEY = """  Where to get your credentials:
    1. Open https://lightning.ai and sign in
    2. Click your organization name/logo, top-left of the nav bar
    3. Global settings  ->  API Keys
    4. Create a key. Copy BOTH the User ID and the API Key — the key is shown once."""


def mask(secret: str | None) -> str:
    """Show enough to recognise a key, never enough to use it."""
    if not secret:
        return "(unset)"
    if len(secret) <= 12:
        return "*" * len(secret)
    return f"{secret[:4]}…{secret[-4:]}  ({len(secret)} chars)"


def credentials_path():
    try:
        import pathlib

        from lightning_sdk.lightning_cloud import env

        return pathlib.Path(env.LIGHTNING_CREDENTIAL_PATH)
    except Exception:  # noqa: BLE001
        return None


def auth_state() -> dict:
    """Work out how (and whether) the SDK will authenticate, without triggering it.

    Precedence inside Auth.authenticate() is: env vars first, then the credentials file,
    and if neither is present it opens a BROWSER and blocks. That last branch is why a
    headless run with no credentials hangs instead of failing — worth knowing before you
    burn ten minutes on it.
    """
    uid = os.environ.get("LIGHTNING_USER_ID")
    key = os.environ.get("LIGHTNING_API_KEY")
    token = os.environ.get("LIGHTNING_AUTH_TOKEN")
    path = credentials_path()
    file_ok = bool(path and path.exists())

    if key or token:
        source = "environment variables"
    elif file_ok:
        source = f"credentials file ({path})"
    else:
        source = None
    return {
        "user_id": uid,
        "api_key": key,
        "auth_token": token,
        "cred_path": path,
        "cred_file_exists": file_ok,
        "source": source,
    }


def cmd_auth(args):
    print(bold("\nLightning AI authentication\n"))

    # 1. Is the SDK even importable, on a supported Python?
    py = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    py_ok = sys.version_info >= (3, 11)
    print(f"  python          {py} {'' if py_ok else red('— lightning-sdk needs >= 3.11')}")
    try:
        import lightning_sdk

        print(f"  lightning_sdk   {lightning_sdk.__version__}  {dim(lightning_sdk.__file__)}")
    except ImportError:
        print(f"  lightning_sdk   {red('NOT INSTALLED')}")
        print("\n  Install it first:\n    pip install -U lightning-sdk")
        if not py_ok:
            print(red(f"    (your interpreter is {py}; lightning-sdk requires Python >= 3.11)"))
        return 1

    # 2. Where would credentials come from?
    st = auth_state()
    print()
    print(f"  LIGHTNING_USER_ID     {mask(st['user_id'])}")
    print(f"  LIGHTNING_API_KEY     {mask(st['api_key'])}")
    if st["auth_token"]:
        print(f"  LIGHTNING_AUTH_TOKEN  {mask(st['auth_token'])}")
    print(
        f"  credentials file      {st['cred_path']} "
        f"{'(present)' if st['cred_file_exists'] else dim('(absent)')}"
    )
    print()

    if st["source"] is None:
        print(red("  No credentials found."))
        print(
            yellow(
                "\n  Careful: with no credentials the SDK does not raise — it opens a browser\n"
                "  and blocks waiting for you to log in. In a script, CI job, or agent session\n"
                "  that just hangs. Set the environment variables instead."
            )
        )
        print()
        print(WHERE_TO_GET_KEY)
        print(
            "\n  Then, for this shell:\n"
            "    export LIGHTNING_USER_ID=<your-user-id>\n"
            "    export LIGHTNING_API_KEY=<your-api-key>\n"
            "\n  To persist it, append those two lines to your shell profile\n"
            f"    ({os.environ.get('ZDOTDIR', '~')}/.zshrc or ~/.bashrc)\n"
            "\n  Interactive alternative (opens a browser, writes the credentials file):\n"
            "    lightning login\n"
        )
        print(dim("  Re-run `python lai.py auth` once set."))
        return 1

    print(f"  resolving via   {green(st['source'])}")
    if st["api_key"] and not st["user_id"]:
        print(
            yellow(
                "  WARN  LIGHTNING_API_KEY is set but LIGHTNING_USER_ID is not. The SDK wants\n"
                "        both for API-key auth — expect a failure below."
            )
        )

    # 3. Prove it actually works. An unverified key is not a working setup.
    print(dim("\n  verifying against the API…"))
    try:
        ts = get_teamspace(args.teamspace, args.org, args.user)
        n = len(ts.jobs)
        print(f"  {green('OK')}  authenticated — teamspace '{ts.name}', owner {ts.owner}, {n} jobs")
    except Exception as e:  # noqa: BLE001
        print(f"  {red('FAILED')}  {type(e).__name__}: {str(e)[:200]}")
        print(
            "\n  Common causes:\n"
            "    - key revoked or mistyped (they're shown once; regenerate if unsure)\n"
            "    - USER_ID and API_KEY from different accounts\n"
            "    - teamspace/org name wrong — pass --teamspace and --org explicitly\n"
        )
        print(WHERE_TO_GET_KEY)
        return 1

    if not (os.environ.get("LIGHTNING_TEAMSPACE") and os.environ.get("LIGHTNING_ORG")):
        print(
            dim(
                "\n  note  LIGHTNING_TEAMSPACE / LIGHTNING_ORG aren't set. Fine inside a Studio\n"
                "        (inferred), but set them for scripts that run elsewhere."
            )
        )
    print()
    return 0


# --- SDK access -----------------------------------------------------------


def get_teamspace(name=None, org=None, user=None):
    """Resolve a Teamspace. Inside a Studio this needs no arguments.

    Outside one, a teamspace is owned by either an organization or a user — personal
    teamspaces have no org at all. So don't demand both: pass through whatever was given
    and let the SDK decide, rather than silently discarding an explicit --teamspace
    because --org happened to be absent.
    """
    try:
        from lightning_sdk import Teamspace
    except ImportError:
        sys.exit(
            "lightning_sdk is not installed in this interpreter.\n"
            "  pip install -U lightning-sdk   (requires Python >= 3.11)\n"
            "Then run `python lai.py auth` to set up credentials."
        )

    # Fail fast rather than letting the SDK open a browser and block. A hung agent or CI
    # job looks like a network problem for a long time before anyone suspects auth.
    if auth_state()["source"] is None:
        sys.exit(
            "No Lightning credentials found, and the SDK would open a browser and block.\n"
            "Run `python lai.py auth` for setup instructions."
        )

    name = name or os.environ.get("LIGHTNING_TEAMSPACE")
    org = org or os.environ.get("LIGHTNING_ORG")
    # A teamspace has exactly one owner, so never send both. LIGHTNING_USERNAME is set
    # inside every Studio even when the teamspace is org-owned, so it's only a fallback.
    if not org:
        user = user or os.environ.get("LIGHTNING_USERNAME")
    else:
        user = None
    kwargs = {k: v for k, v in (("name", name), ("org", org), ("user", user)) if v}
    try:
        return Teamspace(**kwargs) if kwargs else Teamspace()
    except Exception as e:  # noqa: BLE001 - surface the real cause to the user
        tried = ", ".join(f"{k}={v!r}" for k, v in kwargs.items()) or "no arguments (inferred)"
        sys.exit(
            f"Could not resolve a teamspace ({type(e).__name__}: {e}).\n"
            f"Tried: {tried}\n\n"
            "Outside a Studio you must name the teamspace and say who owns it:\n"
            "  --teamspace <name> --org <org>     (organization-owned)\n"
            "  --teamspace <name> --user <user>   (personal teamspace — no org)\n"
            "or export LIGHTNING_TEAMSPACE with LIGHTNING_ORG / LIGHTNING_USERNAME.\n"
            "Run `python lai.py auth` to check credentials and get setup steps."
        )


def has_spot(m) -> bool:
    """Whether interruptible is actually offered.

    Some accounts report interruptible_cost as 0/None meaning 'not available', not
    'free'. Treating that as the cheapest option would be an expensive mistake.
    """
    return bool(m.interruptible_cost) and m.interruptible_cost > 0


def savings_pct(m):
    """Percent saved by going interruptible, or None if spot isn't offered.

    Negative means spot costs MORE than on-demand, which does happen.
    """
    if not m.cost or not has_spot(m):
        return None
    return (1 - m.interruptible_cost / m.cost) * 100


def fmt_spot(m) -> str:
    return f"{m.interruptible_cost:.2f}" if has_spot(m) else "n/a"


def fmt_cost(m) -> str:
    """`cost` is Optional[float] in the SDK, so don't assume a number is there."""
    return f"{m.cost:.2f}" if m.cost else "n/a"


def confirm(prompt: str, expect: str = "y") -> bool:
    """Ask for confirmation, refusing to proceed when nobody is there to answer.

    Two failure modes to avoid: a bare input() on closed stdin raises EOFError and dumps a
    traceback, and a stray pre-fed line on a pipe would count as consent for an action that
    deletes data. Neither is acceptable for an irreversible step, so require a real TTY.
    """
    if not sys.stdin.isatty():
        print(
            red("\nRefusing to prompt: stdin is not a terminal.")
            + "\nRun this interactively — irreversible actions need a human answer."
        )
        return False
    try:
        return input(prompt).strip().lower() == expect
    except (EOFError, KeyboardInterrupt):
        print("\nAborted.")
        return False


def fmt_wait(seconds) -> str:
    """Queue wait in human terms. Long waits are the hidden cost of scarce GPUs."""
    if seconds is None:
        return "?"
    s = float(seconds)
    if s < 120:
        return f"{s:.0f}s"
    if s < 7200:
        return f"{s / 60:.0f}m"
    if s < 172800:
        return f"{s / 3600:.1f}h"
    return f"{s / 86400:.1f}d"


# --- subcommand: whoami ---------------------------------------------------


def effective_account(ts) -> tuple[str | None, str]:
    """Which cloud account list_machines() will actually query, and why.

    Order matters and is easy to get wrong: an explicit argument wins, then the
    LIGHTNING_CLUSTER_ID env var, and only if both are absent does it fan out across
    every global account. `default_cloud_account` is NOT consulted — so inside a Studio
    the prices you get are the Studio's cluster, which may differ from the teamspace
    default.
    """
    env = os.environ.get("LIGHTNING_CLUSTER_ID")
    if env:
        return env, "LIGHTNING_CLUSTER_ID env var"
    return None, "no cloud account pinned — queries all global accounts"


def cmd_whoami(args):
    ts = get_teamspace(args.teamspace, args.org, args.user)
    print(bold("\nLightning AI context"))
    print(f"  teamspace       {ts.name}")
    print(f"  owner           {ts.owner}")
    print(f"  teamspace default cloud account  {ts.default_cloud_account}")

    eff, why = effective_account(ts)
    print(f"  machine lookups resolve to       {eff or 'ALL accounts'}  {dim(f'({why})')}")
    if eff and eff != ts.default_cloud_account:
        print(
            f"  {yellow('NOTE')}  these differ. `list_machines()` follows LIGHTNING_CLUSTER_ID, not the\n"
            f"        teamspace default, so prices you see are for '{eff}'."
        )
    accounts = [a for a in (ts.cloud_accounts or []) if a != ts.default_cloud_account]
    if accounts:
        print(f"  other accounts  {', '.join(accounts)}")
        print(dim("  (run `lai.py compare --family <FAM>` to price a machine across all of them)"))

    try:
        jobs = ts.jobs
        print(f"  jobs            {len(jobs)}")
        if len(jobs) > 100:
            print(
                f"  {yellow('WARN')}  over 100 jobs — artifacts count toward storage and it gets "
                "hard to tell what's still needed. Consider a cleanup pass."
            )
    except Exception as e:  # noqa: BLE001
        print(f"  jobs            {dim(f'(unavailable: {e})')}")

    env_auth = bool(os.environ.get("LIGHTNING_API_KEY"))
    print(f"  auth via env    {'yes' if env_auth else 'no (using stored credentials)'}")
    print()
    return 0


# --- subcommand: prices ---------------------------------------------------


def cmd_prices(args):
    ts = get_teamspace(args.teamspace, args.org, args.user)
    acct = args.cloud_account
    machines = ts.list_machines(cloud_account=acct) if acct else ts.list_machines()
    shown_acct = acct or (effective_account(ts)[0] or "all global accounts")

    if args.family:
        want = args.family.upper().replace("_", "-")
        machines = [m for m in machines if m.family.upper() == want]
    if args.gpu:
        machines = [m for m in machines if m.family.upper() not in ("CPU", "DATA-PREP")]
    if not machines:
        print("No machines matched that filter.")
        return 1

    if args.json:
        import json

        print(
            json.dumps(
                [
                    {
                        "slug": m.slug,
                        "family": m.family,
                        "instance_type": m.instance_type,
                        "accelerator_count": m.accelerator_count,
                        "cost": m.cost,
                        "interruptible_cost": m.interruptible_cost,
                        "savings_pct": round(savings_pct(m), 1),
                        "wait_time_s": m.wait_time,
                        "interruptible_wait_time_s": m.interruptible_wait_time,
                        "provider": m.provider,
                    }
                    for m in machines
                ],
                indent=2,
            )
        )
        return 0

    machines.sort(key=lambda m: (m.family, m.cost or 0.0))
    print(bold(f"\nLive machine prices — {ts.name} / {shown_acct}"))
    print(dim("  $/hr. 'spot' = interruptible. 'wait' = observed queue time."))
    print(dim("  Out-of-capacity machines are already filtered out by the API.\n"))
    hdr = f"  {'family':<10} {'slug':<28} {'n':>3} {'on-demand':>10} {'spot':>9} {'save':>6}  {'wait':>7} {'spot wait':>9}"
    print(bold(hdr))
    print(dim("  " + "-" * (len(hdr) - 2)))

    flagged, no_spot = [], []
    for m in machines:
        sav = savings_pct(m)
        if sav is None:
            sav_s = dim(f"{'n/a':>5}")
            no_spot.append(m)
        elif sav < 0:
            sav_s = red(f"{sav:>5.0f}%")
            flagged.append(m)
        else:
            sav_s = f"{sav:>5.0f}%"
        print(
            f"  {m.family:<10} {m.slug:<28} {m.accelerator_count:>3} "
            f"{fmt_cost(m):>10} {fmt_spot(m):>9} {sav_s}  "
            f"{fmt_wait(m.wait_time):>7} {fmt_wait(m.interruptible_wait_time):>9}"
        )

    if flagged:
        print()
        print(yellow("  Interruptible costs MORE than on-demand on:"))
        for m in flagged:
            print(f"    {m.slug}: spot ${m.interruptible_cost:.2f} vs on-demand ${m.cost:.2f}/hr")
        print(dim("  Use interruptible=False on these."))

    if no_spot:
        print()
        print(dim(f"  No interruptible option on: {', '.join(m.slug for m in no_spot)}"))
        print(dim("  (reported as 0/None by the API — that means unavailable, not free)"))

    slow = [m for m in machines if m.wait_time and m.wait_time > 3600]
    if slow:
        print()
        print(yellow("  Long on-demand queues (interruptible may be the only practical route):"))
        for m in sorted(slow, key=lambda x: -x.wait_time):
            print(
                f"    {m.slug}: on-demand waits {fmt_wait(m.wait_time)}, "
                f"spot waits {fmt_wait(m.interruptible_wait_time)}"
            )
    print()
    return 0


# --- subcommand: compare --------------------------------------------------


def cmd_compare(args):
    """Price one machine family across every cloud account in the teamspace.

    Worth doing before any long or expensive run: the same family can differ several-fold
    between accounts, and some families only exist on one provider.
    """
    ts = get_teamspace(args.teamspace, args.org, args.user)
    want = args.family.upper().replace("_", "-") if args.family else None

    rows = []
    empty = []
    for acct in ts.cloud_accounts:
        try:
            ms = ts.list_machines(cloud_account=acct)
        except Exception as e:  # noqa: BLE001
            empty.append((acct, f"error: {type(e).__name__}"))
            continue
        if not ms:
            empty.append((acct, "no machines offered"))
            continue
        sel = [m for m in ms if not want or m.family.upper() == want]
        if not sel:
            empty.append((acct, f"no {args.family} here"))
            continue
        for m in sel:
            rows.append((acct, m))

    if args.json:
        import json

        print(
            json.dumps(
                [
                    {
                        "cloud_account": a,
                        "provider": m.provider,
                        "slug": m.slug,
                        "family": m.family,
                        "accelerator_count": m.accelerator_count,
                        "cost": m.cost,
                        "interruptible_cost": m.interruptible_cost,
                        "wait_time_s": m.wait_time,
                        "interruptible_wait_time_s": m.interruptible_wait_time,
                    }
                    for a, m in rows
                ],
                indent=2,
            )
        )
        return 0

    title = f"'{args.family}'" if args.family else "all machines"
    print(bold(f"\n{title} across cloud accounts — {ts.name}\n"))
    if not rows:
        print(f"  {yellow('none found')} in any account.")
        for a, why in empty:
            print(dim(f"    {a}: {why}"))
        print()
        return 1

    hdr = f"  {'cloud account':<34} {'provider':<14} {'slug':<26} {'n':>3} {'on-demand':>10} {'spot':>9} {'wait':>7}"
    print(bold(hdr))
    print(dim("  " + "-" * (len(hdr) - 2)))
    for a, m in sorted(rows, key=lambda r: (r[1].accelerator_count, r[1].cost or 0.0)):
        print(
            f"  {a:<34} {str(m.provider):<14} {m.slug:<26} {m.accelerator_count:>3} "
            f"{fmt_cost(m):>10} {fmt_spot(m):>9} {fmt_wait(m.wait_time):>7}"
        )

    # Cheapest per GPU count is the actionable takeaway.
    by_n = {}
    for a, m in rows:
        by_n.setdefault(m.accelerator_count, []).append((a, m))
    print()
    for n in sorted(by_n):
        priced = [r for r in by_n[n] if r[1].cost]
        if not priced:
            continue
        best = min(priced, key=lambda r: r[1].cost)
        print(
            f"  cheapest at {n:>2} × : {green(best[1].slug)} ${best[1].cost:.2f}/hr on-demand "
            f"on {best[0]}  {dim('(queue ' + fmt_wait(best[1].wait_time) + ')')}"
        )
        spot_rows = [r for r in by_n[n] if has_spot(r[1])]
        if spot_rows:
            bs = min(spot_rows, key=lambda r: r[1].interruptible_cost)
            print(
                f"  {'':16} {bs[1].slug} ${bs[1].interruptible_cost:.2f}/hr spot on {bs[0]}  "
                f"{dim('(queue ' + fmt_wait(bs[1].interruptible_wait_time) + ')')}"
            )

    if empty:
        print(dim("\n  not available on:"))
        for a, why in empty:
            print(dim(f"    {a}: {why}"))
    print(
        yellow(
            "\n  Before switching accounts: artifacts are only visible from a Studio on the\n"
            "  same provider. Moving providers mid-project means switching the base Studio."
        )
    )
    print()
    return 0


# --- subcommand: preflight ------------------------------------------------


# The enum's family string equals the live one for every family except this. Keeping the
# exceptions explicit means an unknown mismatch fails loudly instead of matching the wrong
# hardware — a prefix/startswith match would silently make 'L4' accept an 'L40S'.
FAMILY_ALIASES = {"RTXPRO": "RTXP"}


def norm_family(s: str) -> str:
    return "".join(c for c in s.upper() if c.isalnum())


def variant_ok(enum_name: str, slug: str) -> bool:
    """Guard the sub-variants that share a family and GPU count.

    A100_40GB and A100_80GB are both family 'A100' with the same accelerator_count, as are
    T4 and T4_SMALL. Matching on (family, count) alone would let a request for one silently
    resolve to the other — different hardware, very different price.
    """
    key, sl = enum_name.upper(), slug.lower()
    for mem in ("40GB", "80GB"):
        if mem in key and mem.lower() not in sl:
            return False
    # 'SMALL' is a distinct cheaper instance; don't cross the boundary in either direction.
    if ("SMALL" in key) != ("small" in sl):
        return False
    return True


def resolve_machine(ts, name: str, f: Findings, cloud_account: str | None = None):
    """Map a user-supplied machine name onto a live, priced machine record.

    Two separate checks matter here. `Machine.<NAME>` raises for a bad name, but
    `Machine.from_str` happily returns the string, so a typo survives until submit.

    Resolution never falls back to a different GPU family. Quoting the price of hardware
    the user didn't ask for is worse than admitting we couldn't find it.
    """
    from lightning_sdk import Machine

    valid_enum = {n for n in dir(Machine) if n.isupper()}
    key = name.upper()
    if key not in valid_enum:
        f.error(
            f"Machine.{key} does not exist in this SDK version. "
            f"(A10G is the classic one — it was removed.) Run `lai.py prices` for what's real."
        )
        close = sorted(n for n in valid_enum if n.startswith(key.split("_")[0][:2]))
        if close:
            f.note(f"Similar names: {', '.join(close[:8])}")
        return None

    machine = getattr(Machine, key)
    live = ts.list_machines(cloud_account=cloud_account) if cloud_account else ts.list_machines()

    # 1. Exact slug. The enum member carries a populated `slug` but a null `instance_type`,
    #    so slug is the join key onto the live (priced) records.
    slug = getattr(machine, "slug", None)
    for m in live:
        if slug and m.slug == slug:
            return m

    # 2. Exact family + GPU count + variant. Generic aliases like A100_X_8 (slug
    #    'lit-a100-8') need this because an account may only sell 'lit-a100-80gb-8'.
    want_fam = norm_family(getattr(machine, "family", "") or "")
    want_fam = FAMILY_ALIASES.get(want_fam, want_fam)
    want_n = getattr(machine, "accelerator_count", 1) or 1
    cands = [
        m
        for m in live
        if norm_family(m.family) == want_fam
        and m.accelerator_count == want_n
        and variant_ok(key, m.slug)
        and m.cost
    ]
    if cands:
        best = min(cands, key=lambda m: m.cost)
        if len(cands) > 1:
            f.note(
                f"{key} matched {len(cands)} instances in family {best.family}; "
                f"using the cheapest ({best.slug})."
            )
        return best

    acct = cloud_account or effective_account(ts)[0] or "the accounts queried"
    same_fam = sorted({m.family for m in live if norm_family(m.family) == want_fam})
    if same_fam:
        f.warn(
            f"Machine.{key} — '{same_fam[0]}' exists on '{acct}' but not with "
            f"{want_n} accelerator(s) in that variant. `lai.py prices --family {same_fam[0]}` "
            "shows the sizes actually offered."
        )
    else:
        f.warn(
            f"Machine.{key} is a valid SDK name but family '{want_fam}' isn't offered by "
            f"'{acct}'. It may exist elsewhere — check "
            f"`lai.py compare --family {key.split('_')[0]}`."
        )
    return None


def cmd_preflight(args):
    f = Findings()
    ts = get_teamspace(args.teamspace, args.org, args.user)

    print(bold(f"\nPreflight — job '{args.name}' on {args.machine}\n"))

    # 1. name uniqueness: names must be unique within the teamspace
    try:
        existing = {j.name for j in ts.jobs}
        if args.name in existing:
            f.error(
                f"A job named '{args.name}' already exists in {ts.name}. "
                "Job names must be unique within the teamspace — submitting will fail. "
                "In a sweep, suffix the name per run, e.g. f'sweep-lr{lr}'."
            )
    except Exception as e:  # noqa: BLE001
        f.note(f"Could not check name uniqueness ({e}).")

    # 2. studio vs image: mutually exclusive, and one is needed for a command
    if args.studio and args.image:
        f.error("studio= and image= are mutually exclusive — pass exactly one.")
    if not args.studio and not args.image:
        f.note("Neither studio nor image given; the job will use the teamspace default env.")

    # 3. machine validity + pricing
    m = resolve_machine(ts, args.machine, f, args.cloud_account)
    est = None
    if m and not m.cost:
        f.warn(
            f"{m.slug} resolved but reports no price. Can't estimate cost — check it in "
            "the UI before submitting."
        )
        m = None
    if m:
        sav = savings_pct(m)
        spot_ok = has_spot(m)
        use_spot = args.interruptible and spot_ok
        rate = m.interruptible_cost if use_spot else m.cost
        chosen = "interruptible" if use_spot else "on-demand"
        wait = m.interruptible_wait_time if use_spot else m.wait_time

        print(f"  machine   {args.machine}  ({m.slug}, {m.accelerator_count} × {m.family}, {m.provider})")
        print(f"  account   {args.cloud_account or effective_account(ts)[0] or 'all global'}")
        print(f"  rate      ${m.cost:.2f}/hr on-demand")
        if spot_ok:
            print(f"            ${m.interruptible_cost:.2f}/hr interruptible   ({sav:+.0f}%)")
        else:
            print(f"            {dim('interruptible not offered on this machine')}")
        print(f"  using     {chosen} at ${rate:.2f}/hr")
        print(f"  queue     ~{fmt_wait(wait)}")
        if args.hours:
            est = rate * args.hours
            print(f"  est {args.hours:g}h   {bold(f'~${est:.2f}')}")
        print()

        if args.interruptible and not spot_ok:
            f.error(
                "interruptible=True requested but this machine reports no interruptible "
                "price (0/None means unavailable, not free). It will run on-demand at "
                f"${m.cost:.2f}/hr — budget for that or pick another machine."
            )
        elif use_spot and sav < 0:
            f.error(
                f"interruptible=True costs MORE here: ${m.interruptible_cost:.2f} vs "
                f"${m.cost:.2f}/hr on-demand ({sav:+.0f}%). Drop interruptible."
            )
        elif use_spot and sav < 15:
            f.warn(
                f"interruptible saves only {sav:.0f}% on this machine — probably not worth "
                "the preemption risk unless the queue is the reason."
            )
        if not use_spot and m.wait_time and m.wait_time > 3600:
            msg = f"on-demand queue for {m.slug} is ~{fmt_wait(m.wait_time)}"
            if spot_ok:
                msg += (
                    f" (interruptible ~{fmt_wait(m.interruptible_wait_time)}). Here interruptible "
                    "is about getting the hardware at all, not saving money."
                )
            else:
                msg += (
                    ". No interruptible option here — check `lai.py compare --family "
                    f"{args.machine.split('_')[0]}` for an account with capacity."
                )
            f.warn(msg)
        if use_spot and args.hours and args.hours > 6:
            f.warn(
                f"{args.hours:g}h on interruptible — make sure the job checkpoints and resumes, "
                "or a preemption near the end throws away the whole run."
            )
        if m.accelerator_count >= 4 and m.family.upper() not in ("CPU", "DATA-PREP"):
            same_acct = (
                ts.list_machines(cloud_account=args.cloud_account)
                if args.cloud_account
                else ts.list_machines()
            )
            singles = [
                x for x in same_acct if x.family == m.family and x.accelerator_count == 1 and x.cost
            ]
            ratio = f"~{m.cost / singles[0].cost:.1f}×" if singles else f"~{m.accelerator_count}×"
            f.note(
                f"{m.accelerator_count} GPUs costs {ratio} a single {m.family}. Worth it only if "
                "the job scales near-linearly or the model won't fit otherwise."
            )
        if est and est > 50:
            f.warn(f"estimated ${est:.2f} — large enough to double-check the command first.")

    # 4. runaway protection
    if not args.max_runtime:
        sev = f.warn if (m and m.cost > 5) else f.note
        sev(
            "no max_runtime set. A hung job bills until someone notices; on expensive "
            "machines that's the single most likely way to waste credits."
        )

    return f.render()


# --- subcommand: jobs -----------------------------------------------------


def cmd_jobs(args):
    ts = get_teamspace(args.teamspace, args.org, args.user)
    jobs = ts.jobs
    if args.limit and len(jobs) > args.limit:
        print(dim(f"  showing first {args.limit} of {len(jobs)} jobs (--limit 0 for all)"))
        jobs = jobs[: args.limit]
    rows = []
    for j in jobs:
        try:
            status = str(j.status).split(".")[-1]
        except Exception:  # noqa: BLE001
            status = "?"
        if args.status and status.lower() != args.status.lower():
            continue
        rows.append((j, status))

    print(bold(f"\nJobs in {ts.name}  ({len(rows)} shown / {len(jobs)} total)\n"))
    if not rows:
        print(dim("  none"))
        print()
        return 0

    total = 0.0
    for j, status in rows:
        cost = ""
        try:
            if j.total_cost:
                total += float(j.total_cost)
                cost = f"${float(j.total_cost):.2f}"
        except Exception:  # noqa: BLE001
            pass
        colour = {"Completed": green, "Failed": red, "Running": yellow}.get(status, dim)
        print(f"  {j.name:<44} {colour(status):<20} {cost:>9}")
    if total:
        print(dim(f"\n  total accounted spend: ${total:.2f}"))

    if len(jobs) > 100:
        print(
            yellow(
                f"\n  {len(jobs)} jobs. Artifacts count toward teamspace storage, and past ~100 "
                "it's hard to tell what's still needed."
            )
        )

    if args.delete_completed:
        targets = [j for j, s in rows if s == "Completed"]
        if not targets:
            print("\nNothing completed to delete.")
            return 0
        print(bold(f"\nAbout to delete {len(targets)} completed job(s) and their artifacts:"))
        for j in targets:
            print(f"    {j.name}")
        print(
            yellow(
                "\nThis removes their artifacts too. Make sure anything you need is copied "
                "somewhere durable first."
            )
        )
        if not confirm("Type 'delete' to confirm: ", expect="delete"):
            print("Aborted — nothing deleted.")
            return 0
        for j in targets:
            try:
                j.delete()
                print(f"  deleted {j.name}")
            except Exception as e:  # noqa: BLE001
                print(f"  {red('failed')} {j.name}: {e}")
    print()
    return 0


# --- entrypoint -----------------------------------------------------------


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="lai.py",
        description="Lightning AI helper — orient, price, preflight, and tidy up.",
    )
    # Shared scope flags, attached to the top-level parser AND every subcommand so they
    # work on either side of it. Argparse only honours parent-parser options *before* the
    # subcommand, and `lai.py whoami --teamspace X` failing is a baffling error.
    scope = argparse.ArgumentParser(add_help=False)
    scope.add_argument("--teamspace", help="override teamspace (else env / Studio context)")
    scope.add_argument("--org", help="owning organization")
    scope.add_argument("--user", help="owning user, for personal teamspaces that have no org")
    for a in scope._actions:
        p._add_action(a)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser(
        "auth", parents=[scope], help="check credentials and print setup steps (start here)"
    ).set_defaults(func=cmd_auth)

    sub.add_parser("whoami", parents=[scope], help="show teamspace, cloud account, job count").set_defaults(
        func=cmd_whoami
    )

    sp = sub.add_parser("prices", parents=[scope], help="live machine prices, spot deltas, queue waits")
    sp.add_argument("--gpu", action="store_true", help="GPU families only")
    sp.add_argument("--family", help="filter to one family, e.g. L4 / A100 / CPU")
    sp.add_argument(
        "--cloud-account",
        dest="cloud_account",
        help="query a specific cloud account (else LIGHTNING_CLUSTER_ID, else all)",
    )
    sp.add_argument("--json", action="store_true", help="machine-readable output")
    sp.set_defaults(func=cmd_prices)

    sc = sub.add_parser(
        "compare", parents=[scope], help="price a machine family across every cloud account (slow: queries each)"
    )
    sc.add_argument("--family", help="family to compare, e.g. H100 / A100 / L40S / T4")
    sc.add_argument("--json", action="store_true", help="machine-readable output")
    sc.set_defaults(func=cmd_compare)

    sf = sub.add_parser("preflight", parents=[scope], help="validate and price a job before submitting")
    sf.add_argument("--name", required=True, help="job name (must be unique in teamspace)")
    sf.add_argument("--machine", required=True, help="Machine enum name, e.g. L4, A100_X_8")
    sf.add_argument("--hours", type=float, help="expected runtime, for the cost estimate")
    sf.add_argument("--interruptible", action="store_true", help="plan to use spot")
    sf.add_argument("--studio", help="studio env name (mutually exclusive with --image)")
    sf.add_argument("--image", help="docker image (mutually exclusive with --studio)")
    sf.add_argument("--max-runtime", type=int, dest="max_runtime", help="seconds")
    sf.add_argument(
        "--cloud-account",
        dest="cloud_account",
        help="price against a specific cloud account (else LIGHTNING_CLUSTER_ID)",
    )
    sf.set_defaults(func=cmd_preflight)

    sj = sub.add_parser("jobs", parents=[scope], help="list jobs, spend, and clean up")
    sj.add_argument("--status", help="filter, e.g. Completed / Failed / Running")
    sj.add_argument(
        "--limit",
        type=int,
        default=50,
        help="max jobs to inspect (0 = all). Each one costs an API call for its spend.",
    )
    sj.add_argument(
        "--delete-completed", action="store_true", help="delete completed jobs (asks first)"
    )
    sj.set_defaults(func=cmd_jobs)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
