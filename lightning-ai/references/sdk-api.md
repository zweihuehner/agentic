# lightning_sdk API reference

Verified against `lightning_sdk` 2026.06.08. Prefer this over memory — several widely
circulated examples use parameters and machine names that no longer exist.

## Install and authenticate

```bash
pip install -U lightning-sdk     # requires Python >= 3.11
```

Run `python scripts/lai.py auth` to check and set this up — it verifies against the API
rather than just looking for variables. Summary, in the SDK's own precedence order:

1. **Environment variables** (checked first, and they override everything else):
   `LIGHTNING_USER_ID` + `LIGHTNING_API_KEY`, or `LIGHTNING_AUTH_TOKEN`. Best for scripts,
   CI, and agents.
2. **Credentials file** `~/.lightning/credentials.json`, written by `lightning login`
   (opens a browser). Cleared by `lightning logout`.
3. **Neither** → the SDK opens a browser and **blocks**. It does not raise. In a headless
   context this looks like a hang, not an auth error.

Inside a Studio the environment is already populated — `Teamspace()` with no arguments
resolves the current teamspace, org, and cloud account.

**Where to get the API key:** top nav bar → your organization name/logo (top-left) →
**Global settings** → **API Keys**. The key is displayed once; copy both it and the User
ID.

Full walkthrough and troubleshooting: `auth-and-setup.md`.

## Top-level exports

`AIHub`, `Agent`, `CloudProvider`, `ConnectionType`, `Deployment`, `FolderLocation`,
`Job`, `JobsPlugin`, `K8sCluster`, `MMT`, `Machine`, `MultiMachineTrainingPlugin`,
`Organization`, `Plugin`, `SlurmJobsPlugin`, `Status`, `Studio`, `Teamspace`, `User`,
`VM`, `VersionChecker`

## `Job.run(...)`

```python
Job.run(
    name: str,                       # required; unique within the teamspace
    machine: Machine | str,          # required
    cloud: CloudProvider | str = None,
    command: str = None,             # required with studio=; optional with image=
    studio: Studio | str = None,     # mutually exclusive with image
    image: str = None,               # mutually exclusive with studio
    teamspace: str | Teamspace = None,
    org: str | Organization = None,
    user: str | User = None,
    cloud_account: str = None,       # DEPRECATED -> cloud
    cloud_provider: CloudProvider | str = None,   # DEPRECATED -> cloud
    env: dict[str, str] = None,
    interruptible: bool = False,
    image_credentials: str = None,   # secret name, for private registries
    cloud_account_auth: bool = False,
    entrypoint: str = None,
    path_mappings: dict[str, str] = None,   # mount cloud connections
    max_runtime: int = None,         # seconds — always set this
    artifacts_local: str = None,     # DEPRECATED -> path_mappings
    artifacts_remote: str = None,    # DEPRECATED -> path_mappings
    reuse_snapshot: bool = True,
    scratch_disks: dict[str, int] = None,
) -> Job
```

### Job instance members

| member | what it gives you |
|---|---|
| `.status` | `Pending` / `Running` / `Completed` / `Failed` / `Stopping` / `Stopped` |
| `.logs` | captured stdout/stderr |
| `.total_cost` | actual spend so far — the honest number |
| `.link` | URL to the job in the UI |
| `.wait()` | block until terminal state |
| `.async_wait()` | awaitable equivalent |
| `.stop()` | stop a running job |
| `.delete()` | remove the job **and its artifacts** |
| `.artifact_path`, `.share_path`, `.snapshot_path` | storage locations |
| `.machine`, `.command`, `.image`, `.studio`, `.teamspace`, `.name` | what it was submitted with |
| `.dict()`, `.json()` | serialise |

## `MMT.run(...)` — multi-machine training

Same signature as `Job.run` plus a required `num_machines: int`, and no `scratch_disks`.

Use MMT when **one** job spans several machines (distributed training). Use a loop of
`Job.run` when you want **N independent** jobs (sweeps, benchmarks). Confusing the two is
expensive in opposite directions.

```python
from lightning_sdk import MMT, Machine

mmt = MMT.run(
    name="ddp-train",
    num_machines=4,
    machine=Machine.A100_X_8,
    command="python train.py",
    studio="my-studio",
    max_runtime=12 * 3600,
)
```

List them with `teamspace.multi_machine_jobs`.

## `Teamspace`

```python
from lightning_sdk import Teamspace
ts = Teamspace()                                    # inside a Studio, or with
                                                    # LIGHTNING_TEAMSPACE + LIGHTNING_ORG set
ts = Teamspace(name="<owner>/<teamspace>")          # explicit; newer SDKs (2026.10+)
ts = Teamspace(name="<teamspace>", org="<owner>")   # explicit; older SDKs (deprecated in 2026.10)
```

Don't write real names into code: `lai.py whoami` prints the export lines for the first
form, and `auth-and-setup.md` ("Naming the teamspace") shows how to list reachable
teamspaces from the credentials. Personal teamspaces resolve through their auto-created
org; see `pitfalls.md` for why the `user=` spelling breaks pricing on older SDKs.

| member | purpose |
|---|---|
| `.jobs` | all jobs — iterate for housekeeping |
| `.multi_machine_jobs` | MMT jobs |
| `.studios`, `.vms` | other compute in the teamspace |
| `.list_machines()` | **live pricing and queue waits** (see below) |
| `.default_cloud_account`, `.cloud_accounts`, `.cloud_account_objs` | provider context |
| `.secrets`, `.set_secret()` | credentials — better than putting keys in `env=` |
| `.upload_file/folder`, `.download_file/folder` | data movement |
| `.new_connection()`, `.new_folder()` | cloud connections and storage |
| `.list_models()`, `.upload_model()`, `.download_model()`, `.list_model_versions()`, `.delete_model()` | model registry |
| `.start_studios_on_interruptible` | teamspace-level spot policy |

### `list_machines()` — the pricing source of truth

Returns `Machine` records, **not** the enum. Prices vary by cloud account and region, so
read them rather than hardcoding.

```python
for m in ts.list_machines():
    print(m.slug, m.family, m.accelerator_count,
          m.cost, m.interruptible_cost,           # $/hr
          m.wait_time, m.interruptible_wait_time, # queue seconds
          m.provider, m.instance_type)
```

Note this list can contain machines with no enum member (TPUs, for instance), and can
omit enum members your account doesn't offer.

## `Studio`

```python
s = Studio(name="my-studio", teamspace="my-teamspace", org="my-org")
s.start(); s.stop()
```

| member | purpose |
|---|---|
| `.start()`, `.stop()`, `.status` | lifecycle |
| `.switch_machine()` | resize without recreating |
| `.auto_shutdown`, `.auto_shutdown_time`, `.auto_sleep`, `.auto_sleep_time` | **stop paying for idle** |
| `.run()`, `.run_and_detach()`, `.run_with_exit_code()` | execute in the Studio |
| `.run_job()`, `.run_mmt()` | submit from the Studio's env |
| `.env`, `.set_env()` | environment variables |
| `.upload_file/folder`, `.download_file/folder` | data movement |
| `.duplicate()`, `.rename()`, `.delete()` | management |
| `.install_plugin()`, `.run_plugin()`, `.available_plugins`, `.installed_plugins` | plugins |
| `.add_ports()`, `.list_ports()`, `.public_ip` | networking |
| `.interruptible`, `.machine`, `.cloud_account`, `.cluster` | placement |

## The `Machine` enum

55 members. Families: `CPU*`, `DATA_PREP*`, `T4*`, `L4*`, `L40S*`, `RTXP_6000*`,
`A100*` (incl. `_40GB` / `_80GB` variants), `H100*`, `H200*`, and `B200_X_8` (8-GPU only).

Beware that several members share a `family` and `accelerator_count` and differ only by a
slug token — `A100_40GB` vs `A100_80GB`, `T4` vs `T4_SMALL`, `CPU` vs `CPU_SMALL`. Any
lookup that matches on family and count alone will confuse them.

`Machine.A10G` does **not** exist. `Machine.from_str("anything")` returns the string
without validating — see `pitfalls.md`.

Class-level helpers: `from_str`, plus per-instance `cost`, `interruptible_cost`,
`wait_time`, `interruptible_wait_time`, `provider`, `family`, `accelerator_count`,
`instance_type`, `is_cpu`.

## References

- SDK on PyPI: https://pypi.org/project/lightning-sdk/
- SDK docs: https://lightning.ai/docs/overview/sdk-reference
- Batch Jobs: https://lightning.ai/docs/overview/batch-jobs/sdk
- Interruptible machines: https://lightning.ai/docs/overview/ai-studio/interruptible-machines
