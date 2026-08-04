# Authentication and first-time setup

Verified against `lightning_sdk` 2026.06.08.

**Start here when anything is unclear about credentials:**

```bash
python scripts/lai.py auth
```

It reports the Python version, whether the SDK is installed, which credential source will
be used, and then *proves* the credentials work by making a real API call. Exit code 1
means not usable.

Credentials are never reproduced in the output, not even partially — you get a length and
a one-way fingerprint:

```
LIGHTNING_API_KEY     set — 36 chars, fingerprint 13d7d621
```

The usual convention of showing the first and last four characters is a trap: those are
real key material, and terminal output ends up in issues, screenshots and docs. Compare
fingerprints when you need to know whether two environments hold the same key.

## Install

```bash
pip install -U lightning-sdk
```

Requires **Python ≥ 3.11**. Inside a Lightning Studio it's already installed.

## Getting credentials

You need two values, and the API key is shown **only once** at creation:

1. Open <https://lightning.ai> and sign in
2. Click your **organization name/logo**, top-left in the nav bar
3. **Global settings** → **API Keys**
4. Create a key, then copy **both** the User ID and the API Key

## The three ways the SDK authenticates

`Auth.authenticate()` resolves in this strict order:

**1. Environment variables — checked first, and they win.**

```bash
export LIGHTNING_USER_ID=<your-user-id>
export LIGHTNING_API_KEY=<your-api-key>
```

This is the right choice for scripts, CI, and agent sessions. Note the precedence: if
these are set, the credentials file is never consulted — so a stale exported key silently
overrides a fresh `lightning login`. That's the first thing to check when a login "didn't
take".

`LIGHTNING_AUTH_TOKEN` is a third accepted variable, used in place of the user-id/api-key
pair.

**2. The credentials file.**

```
~/.lightning/credentials.json
```

Written by `lightning login`, which opens a browser. Good for a personal workstation you
log into once. `lightning logout` clears it.

**3. Neither — and this is the trap.**

With no credentials the SDK **does not raise**. It starts a local server, opens a browser,
and blocks waiting for you to complete an interactive login. In a script, a CI job, or an
agent session with no display, that presents as an unexplained hang — easily ten minutes
of debugging the wrong thing.

`scripts/lai.py` guards against this: it checks for credentials up front and exits with a
clear message rather than letting the SDK block.

## Persisting credentials

For a shell you use repeatedly, append the exports to your profile:

```bash
# ~/.zshrc  or  ~/.bashrc
export LIGHTNING_USER_ID=<your-user-id>
export LIGHTNING_API_KEY=<your-api-key>
```

Inside a Lightning Studio note that `ZDOTDIR` may point at the Studio home rather than the
default location — `lai.py auth` prints the path it detects.

Treat the key like a password: don't commit it, don't paste it into a shared notebook, and
prefer teamspace secrets (`ts.set_secret(...)`) over putting keys in a job's `env=`.

## Naming the teamspace

Credentials say *who* you are; they don't say *where* to work.

**Inside a Studio**, `Teamspace()` needs no arguments — teamspace, org, and cloud account
all come from the environment.

**Outside one**, either pass them explicitly:

```python
ts = Teamspace(name="my-teamspace", org="my-org")
```

or export them so zero-arg construction works:

```bash
export LIGHTNING_TEAMSPACE=<name>
export LIGHTNING_ORG=<org>
```

`lai.py auth` warns when these are unset, since it's fine in a Studio and a failure
everywhere else.

## After rotating a key

Rotating is the right move whenever a key may have been exposed, but the old value
survives in more places than people expect, and every one of them keeps failing until
updated:

- **Exported env vars** in the current shell and in `~/.zshrc` / `~/.bashrc`. These take
  precedence over everything else, so a stale export defeats a fresh `lightning login`.
- **A Lightning Studio's injected environment.** Inside a Studio the credentials are
  injected at boot, not read from a dotfile — so the running Studio keeps the dead key
  until it is **restarted**. Nothing you edit in a shell profile changes that.
- **`~/.lightning/credentials.json`**, if you previously ran `lightning login`.
- **CI secrets, job `env=` blocks, and teamspace secrets** you set earlier.

The symptom is the same in all cases: `Authentication failed. Please run 'lightning
login'`. `lai.py` detects this specific failure and says so plainly rather than blaming
the teamspace name — which is the misleading conclusion the raw error invites, since the
same exception type covers both.

Prefer `ts.set_secret(...)` over pasting keys into job `env=`, so a rotation is one
update rather than a hunt.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Script hangs, no output | No credentials — SDK opened a browser and is blocking | Set the env vars; run `lai.py auth` |
| `Authentication failed. Please run 'lightning login'` | Key revoked, rotated, mistyped, or user-id/key mismatch | See "after rotating a key" below |
| `lightning login` succeeded but calls still fail | A stale `LIGHTNING_API_KEY` export is overriding the file | `unset LIGHTNING_API_KEY`, or update it |
| Works in the Studio, fails locally | Teamspace/org not named | Export `LIGHTNING_TEAMSPACE` / `LIGHTNING_ORG` |
| `ImportError: lightning_sdk` | Wrong interpreter, or Python < 3.11 | `pip install -U lightning-sdk` in the right env |
| Prices look wrong for your provider | `LIGHTNING_CLUSTER_ID` points elsewhere | `lai.py whoami` — see `pitfalls.md` |
