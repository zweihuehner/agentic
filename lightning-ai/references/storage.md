# Storage and data layout

## The billing model

**Total teamspace storage = Studios + Jobs + Data drive**, billed once you pass the free
allowance for that teamspace. Job artifacts count. So does everything sitting in a
Studio's home directory, forgotten from three months ago.

This single fact drives every recommendation below: bulk data in a Studio is the most
expensive and most annoying place to put it.

## Where data should live

| Location | Use for | Notes |
|---|---|---|
| **Cloud connection** (S3, GCS) | Datasets, long-lived outputs | **Free from Lightning's side.** AWS and GCS integrate well and usually beat native Lightning storage on price. |
| **Lightning storage** `/teamspace/lightning_storage/` | Shared working data across Studios and Jobs | Central, easy to survey. Counts toward the teamspace allowance. |
| **Datastore** | Long-term, versioned datasets | Move data here to get it out of teamspace accounting. |
| **Studio home** `/teamspace/studios/this_studio/` | Code, notebooks, small configs | Keep it lean — see below. |
| **Job artifacts** | Run outputs | Ephemeral by intent. Copy anything you need somewhere durable, then delete. |

## Keep Studios lean

A Studio full of data is slow to start and miserable to clean up, because every start has
to reconcile that filesystem. Symptoms of a Studio that's become a data dump: multi-minute
startups, and no one being sure what's safe to delete.

Practical rule: **code and configs in the Studio, data outside it.** If a file is
regenerable or came from somewhere else, it doesn't belong in the Studio's home.

`.lightningignore` keeps junk out of the Studio snapshot that gets uploaded on job
submit — worth maintaining, since a fat snapshot slows every single submit.

## Mounting storage into jobs

Use `path_mappings` to make a cloud connection visible inside the job:

```python
Job.run(
    name="train-v3",
    machine=Machine.L4,
    command="python train.py --data /data",
    studio="my-studio",
    path_mappings={"/data": "s3://my-bucket/datasets/era5"},
    max_runtime=6 * 3600,
)
```

`artifacts_local` and `artifacts_remote` did this job previously and are **deprecated** —
use `path_mappings` for both input and output mounting.

The advantage over copying data in: the job starts immediately instead of waiting on a
transfer, and there's exactly one copy of the dataset rather than one per job.

## The cloud provider trap

**Job artifacts are visible from a Studio only when the Studio is on the same cloud
provider.** If your base Studio is on GCP and you run a job on AWS, you have to switch the
Studio to AWS to see that job's artifacts — and then you can't see the GCP ones.

Run everything for a project on **one provider**, chosen to sit near your data. Switching
back and forth to read your own outputs wastes time and creates the very real risk of
concluding a job produced nothing when it merely produced it elsewhere.

Check what you're on with `scripts/lai.py whoami`.

## Housekeeping

Job artifacts accumulate silently. Past roughly 100 jobs, nobody can tell what's still
needed, and the storage bill is real.

```bash
python scripts/lai.py jobs                      # what's there, with spend
python scripts/lai.py jobs --status Completed   # review candidates
python scripts/lai.py jobs --delete-completed   # asks before deleting
```

`job.delete()` removes the artifacts too. Copy anything you care about to a cloud
connection or Datastore **first** — deletion isn't reversible, and "I'll definitely
remember what run-47 was" never survives a month.

A useful cadence: after a batch of experiments concludes, promote the runs worth keeping
(copy artifacts out, note the config), then delete the rest in one pass.
