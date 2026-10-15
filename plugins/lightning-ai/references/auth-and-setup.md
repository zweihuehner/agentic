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

## Handing credentials to an agent session

An agent (Claude Code or similar) cannot complete `lightning login` for you: the flow
opens a browser and waits for a human. It also cannot read the key off the website. So
when a session needs credentials that aren't already working, the recovery is a short
hand-off — the user fetches the key, pastes it into the conversation, and the agent
installs and verifies it.

**Recognise it first.** The symptom is usually not "no credentials" but a *dead* key: API
calls return `401 no authentication methods succeeded`, wrapped by the SDK as
`ConnectionError: Authentication failed. Please run 'lightning login'`. Do not send the
user to `lightning login` as the first move — see the trap below.

**Step 1 — user fetches the key.** Both values are needed, and the API key is shown
**only once**:

1. Open <https://lightning.ai> and sign in
2. Click the **organization name/logo**, top-left in the nav bar
3. **Global settings** → **API Keys**
4. Create a key and copy **both** the User ID and the API Key

**Step 2 — user pastes both into the conversation.** Two `NAME=value` lines is enough;
the agent needs the pair, since API-key auth fails with only one of them.

**Step 3 — agent verifies before installing anything.** Pass them inline for one call
rather than writing them straight to disk, so a typo never overwrites working
credentials:

```bash
LIGHTNING_USER_ID=<id> LIGHTNING_API_KEY=<key> \
  python -c "from lightning_sdk.utils.resolve import _get_authed_user; print(_get_authed_user().name)"
```

Printing the resolved username also confirms the key belongs to the account the user
thinks it does.

**Step 4 — agent persists them**, once verified, by writing `user_id` and `api_key` into
`~/.lightning/credentials.json` (leave `auth_token` empty — the SDK falls back to
user-id/api-key Basic auth). A shell `export` is *not* enough: each agent tool call
typically spawns a fresh shell, so exports do not survive from one command to the next.
The credentials file does.

**Step 5 — agent confirms the teamspace.** Run `lai.py auth`: it lists every teamspace
the new key reaches. One is used automatically; with several, ask the user which. See
"Naming the teamspace" below.

Two things worth saying out loud to the user:

- A key pasted into a conversation lands in that conversation's history and any
  transcript or log the harness keeps. That is usually an acceptable trade for unblocking
  a session, but it makes the key worth rotating afterwards if the environment is shared.
- If the user would rather not paste it, the equivalent is for *them* to add the two
  exports to their shell profile and restart the agent session, so the agent's shells
  inherit them.

### The trap: `lightning login` reports success on a dead key

`lightning login` is not a reliable repair for expired credentials, and telling a user to
run it can burn a lot of time:

- With `LIGHTNING_USER_ID` / `LIGHTNING_API_KEY` exported, `Auth.authenticate()` returns
  at its **first** branch (`login.py`, `if self._with_env_var:`) — before reading the
  file, before any browser. The CLI then writes those same env values to disk. A dead key
  is faithfully re-saved.
- With only the file present, it prints `You are already logged in` based on the file
  **existing**, never on the key working.
- There is no `--force` flag.
- Deleting the file first *does* trigger the browser flow, but Lightning hands back the
  account's **existing** API key — so a byte-identical `credentials.json` afterwards does
  not prove the login failed, and does not fix a revoked key either. Only creating a
  **new** key in the UI does.

Net: verify with a real API call, and treat "the file changed" and "the CLI printed
success" as evidence of nothing.

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

Credentials say *who* you are; they don't say *where* to work. Don't hardcode either —
both can be worked out.

**Inside a Studio**, `Teamspace()` needs no arguments — teamspace, owner, and cloud
account all come from the environment.

**Outside one**, `lai.py` infers it from the credentials: it asks the API who the key
belongs to, lists every teamspace that user can reach, and narrows by whatever you did
give. One match is used and named on stderr; several make it stop and list them as
`owner/teamspace`. Pick one by passing that slug — `--teamspace owner/teamspace` — or just
the name when it is unique. `lai.py auth` prints the full list, and checks a configured
teamspace against it, so a typo fails there rather than on the first real command.

The more specific choice always wins, so a stale export can't veto an explicit one: a
slug beats `--org`/`--user`, which beat `LIGHTNING_TEAMSPACE`/`LIGHTNING_ORG`.
`LIGHTNING_USERNAME` is ignored for this — every Studio sets it, org-owned teamspace or
not. With both name and owner known, the teamspace is constructed directly, no listing.

The same inference in plain SDK calls, for a script of your own:

```python
from lightning_sdk.utils.resolve import _get_authed_user

me = _get_authed_user()                      # the user the key belongs to
for org in me.organizations:                 # includes the personal org, see below
    for ts in org.teamspaces:
        print(f"{org.name}/{ts.name}")
```

Scripts that call a bare `Teamspace()` (the launcher template does) need the choice in
the environment. `lai.py whoami` prints the two lines to copy:

```bash
export LIGHTNING_TEAMSPACE=<teamspace>
export LIGHTNING_ORG=<owner>
```

**Personal teamspaces have two owners on paper.** Lightning backs each personal teamspace
with an auto-created organization named after the user, so it shows up under *both* the
user and that org, with the same id. On older SDKs only the org-owned object can price
machines (the user-owned one has `_org = None`, which `list_machines()` dereferences); see
`pitfalls.md`. `lai.py` therefore always resolves to the org-owned object, and still
accepts `--user <name>` to select it.

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
login'` — which is exactly the advice that will *not* help, for the reasons in "the trap"
above. Create a new key instead.

`lai.py auth` checks the key itself first (it asks the API who the key belongs to)
before touching any teamspace, so a dead key is reported as a dead key — never as a
teamspace problem.

Prefer `ts.set_secret(...)` over pasting keys into job `env=`, so a rotation is one
update rather than a hunt.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Script hangs, no output | No credentials — SDK opened a browser and is blocking | Set the env vars; run `lai.py auth` |
| `Authentication failed. Please run 'lightning login'` | Key revoked, rotated, mistyped, or user-id/key mismatch | See "after rotating a key" below |
| `lightning login` succeeded but calls still fail | It never validated anything — a stale export short-circuits it, and a bare file makes it print "already logged in" | Create a **new** key in the UI; see "Handing credentials to an agent session" |
| Agent session: `export` works once, then auth fails again | Each tool call spawns a fresh shell; exports don't persist | Write `~/.lightning/credentials.json` instead |
| `lai.py` stops with "Several teamspaces match" | More than one reachable teamspace, none chosen | Pass `--teamspace owner/teamspace` from its list |
| Works in the Studio, a script fails locally | The script calls bare `Teamspace()` | Export the two lines `lai.py whoami` prints |
| `ImportError: lightning_sdk` | Wrong interpreter, or Python < 3.11 | `pip install -U lightning-sdk` in the right env |
| Prices look wrong for your provider | `LIGHTNING_CLUSTER_ID` points elsewhere | `lai.py whoami` — see `pitfalls.md` |
