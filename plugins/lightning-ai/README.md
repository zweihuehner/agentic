# lightning-ai

A skill for research work on [Lightning AI](https://lightning.ai):
authentication, batch Jobs via `lightning_sdk`, live machine pricing across
cloud accounts, cost control, and storage layout.

Grounded against `lightning_sdk` 2026.06.08 by querying a live teamspace, not
by reading docs. That matters: several widely circulated examples don't work.

Needs Python ≥ 3.11 with `lightning-sdk`, and Lightning credentials.

## lai.py

The bundled script works on its own, without Claude. It never submits a job:
it prices and validates, and submitting stays an explicit, confirmed act.

```bash
python scripts/lai.py auth        # check credentials, print setup steps
python scripts/lai.py whoami      # teamspace, cloud account, job count
python scripts/lai.py prices      # live $/hr, spot delta, queue wait
python scripts/lai.py compare --family H100   # across all cloud accounts
python scripts/lai.py preflight --name train --machine L4 --hours 3
python scripts/lai.py jobs        # list, spend, cleanup
```

## Some of what it catches

- **`Machine.A10G` doesn't exist** in current SDK versions, though it's all
  over older examples. `Machine.from_str()` accepts typos silently, so bad
  names survive to submit.
- **Interruptible is not reliably cheaper.** Observed deltas span from spot
  costing over 3× on-demand to ~70% cheaper, on the same teamspace.
- **`interruptible_cost` of 0 means unavailable, not free**: read naively it
  looks like the cheapest option on the board.
- **Queue wait can dominate price.** On-demand queues for scarce GPUs have run
  to *days* where spot ran to minutes.
- **`list_machines()` ignores `default_cloud_account`.** It follows
  `LIGHTNING_CLUSTER_ID`, so inside a Studio you can price a different account
  than you assume.
- **Job names must be unique per teamspace**, so a sweep looping over one name
  silently runs only its first job.

No price tables are committed: the catalogue varies by cloud account and
changes over time, so it's always queried.
