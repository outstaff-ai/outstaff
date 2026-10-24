---
title: Docker Compose
description: Run an office with Postgres and one agent per person on a single Docker host.
---

The example in [`examples/compose`](https://github.com/outstaff-ai/outstaff/tree/main/examples/compose) runs the synthetic acme team: one office, its Postgres, and one agent for each of the eight people in the team file. CI starts it with dummy secrets on every change, so what you read here works.

The secret names in this guide and in the example are the acme example's (github, itsaplan, slack and claude-agent-sdk). Your keys depend on your `integrations`; run `ost setup office` and `ost setup <handle>` to get them. Every secret is a file at `/run/secrets/outstaff/<KEY>` whatever its name.

## What you get

| Service           | Image                        | Notes                                                                                               |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `postgres`        | `postgres:18-alpine`         | The office's store. On a network with no route out. Data in the `postgres-data` volume.             |
| `office`          | `ghcr.io/outstaff-ai/office` | Health check on `/healthz`. Publishes no port; agents reach it as `ws://office:8080/agent`.         |
| `priya`, `tomas`… | `ghcr.io/outstaff-ai/agent`  | One service per person, all the same image. `OUTSTAFF_PERSON` differs. Home in a volume per person. |

Every container runs with a read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges` and a `/tmp` tmpfs, as the images guide asks. Services restart with `unless-stopped`. Limits follow the starting points of the [container contract](/reference/container-contract/): 0.5 vCPU and 512 MiB for the office, 1 vCPU and 2 GiB for an agent.

## Before you start

You need Docker with Compose v2.24 or newer, the team file of your own team, and the credentials of each person (the accounts and apps are created by hand; `ost setup` prints the steps and writes a template that says where every value comes from).

1. **Team file.** The example mounts `examples/acme/.outstaff` at `/team`. For your team, set `OUTSTAFF_TEAM_DIR` to the folder that holds your `team.yaml`.
2. **People.** One agent service per person in `team.yaml`. Copy a service block, rename it, and add its secrets and volume. Remove the services of people you do not have.
3. **Secrets.** One file per secret under `examples/compose/secrets/`, listed in the README in that folder. The [Secrets guide](/guides/secrets/) shows how to fill the folder from 1Password or SOPS.
4. **Password.** `cp .env.example .env` and set `POSTGRES_PASSWORD`.

## Start it

```sh
cd examples/compose
docker compose up -d --build
docker compose ps                  # office and postgres: healthy; agents: running
docker compose logs -f office      # look for "agent connected" lines, one per person
```

To run released images instead of building from the repository, set `OUTSTAFF_OFFICE_IMAGE` and `OUTSTAFF_AGENT_IMAGE` in `.env` (for example `ghcr.io/outstaff-ai/office:1.2.3`) and use `docker compose pull && docker compose up -d`. Pin a version; do not follow `latest`.

On first start the office doesn't pick up existing tickets or pull requests; assign or move a ticket to start work.

## How the pieces fit

**Secrets** use the Compose `secrets:` section with file sources. Each file is mounted read-only at `/run/secrets/outstaff/<KEY>`, which is where the containers look. A person's `OUTSTAFF_AGENT_TOKEN` file is mounted into that agent, and into the office as `OUTSTAFF_AGENT_TOKEN_<HANDLE>`, so the two always match. Compose bind-mounts the files with the permissions they have on the host: they must be readable by uid 10001, the user in the images. Nothing secret is in an `environment:` entry, because an agent's shell inherits its container's environment. The one exception is the office's Postgres URL, which the office reads from the environment only; keep `.env` out of git (the example's `.gitignore` does) and out of reach of other users.

**Volumes.** Each agent's `/home/outstaff` is a named volume holding its worktrees, memory and the tools it installed with mise, so a restart neither loses unpushed work nor downloads the tools again. The `postgres-data` volume is the office's state. Back it up the way you back up any Postgres.

**Networks.** The `backend` network is `internal: true`: only the office and Postgres are on it. Compose has no egress filter, so the office and agents can reach any host on the internet. If you need the allow-list from the [container contract](/reference/container-contract/) (the code host, the tracker, the chat service and the LLM provider only), apply it on the host firewall or run the agents behind an HTTP proxy; Kubernetes can enforce it for you, see the [Kubernetes guide](/guides/kubernetes/).

**Webhooks.** If the team receives webhooks (`office.events: webhook`), publish port 8082 of the office behind a TLS-terminating proxy. Requests are verified by signature. Do not publish 8080 or 8081.

## Day-two tasks

| Task                         | Command                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update to a new release      | Change the image tags, then `docker compose pull && docker compose up -d`.                                                                                                        |
| Rotate a secret              | Replace the file, then `docker compose up -d --force-recreate <service>`.                                                                                                         |
| Add a person                 | Add the person to `team.yaml`, add a service, a volume and secrets, `docker compose up -d`.                                                                                       |
| Restart one agent            | `docker compose restart sam`. The office hands its work item back to the queue.                                                                                                   |
| Why does an agent not start? | `docker compose logs sam`. It prints the reason: a missing secret, an invalid team file, a person who is not on the team, or (with the sandbox on) a host that does not allow it. |

## Subprocess sandbox (optional)

By default the agent's shell commands can read the Claude credential from their environment, the same as Claude Code on a developer's machine; the [runtime adapter](https://github.com/outstaff-ai/outstaff/tree/main/packages/runtime-agent-sdk#sandbox) explains the trade-off and the mitigations. With `sandbox: bubblewrap`, Claude Code removes the credential from each command's environment and runs the command in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox with its own user and PID namespaces and a fresh `/proc`; the runtime also hides the credential files under `/run/secrets/outstaff` there. The [Kubernetes guide](/guides/kubernetes/#subprocess-sandbox-optional) explains each part.

Docker's defaults block bubblewrap, so `compose.sandbox.yaml` adds three `security_opt` entries to every agent; the office keeps the defaults:

| Option                                  | Why                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seccomp=./seccomp/outstaff-bwrap.json` | Docker's default seccomp profile plus `clone` and `unshare` for user, mount, PID and network namespaces, `mount`, `umount2` and `pivot_root`.                                          |
| `systempaths=unconfined`                | bubblewrap mounts a fresh `/proc`, which the kernel refuses while parts of `/proc` are masked. The agent is non-root with no capabilities, so the unmasked paths stay read-only to it. |
| `apparmor=outstaff-agent`               | Docker's default AppArmor profile denies every mount, and Ubuntu 24.04 denies user namespaces to processes without a profile that grants them. Ignored on a host without AppArmor.     |

Turn it on:

1. On a host that enforces AppArmor (`cat /sys/module/apparmor/parameters/enabled` prints `Y`, as on Ubuntu and Debian), load the profile once; it loads again at boot from `/etc/apparmor.d/`. Until it is loaded, Docker refuses to start the agents.

   ```sh
   sudo install -m 0644 examples/compose/apparmor/outstaff-agent /etc/apparmor.d/outstaff-agent
   sudo apparmor_parser -r -W /etc/apparmor.d/outstaff-agent
   ```

2. Set `sandbox: bubblewrap` under `integrations.runtime` in `team.yaml`.
3. Start with both files: `docker compose -f compose.yaml -f compose.sandbox.yaml up -d`.

When the host blocks the sandbox in another way, the agent stops at start with one error that names what is missing and how to fix it.

Docker has no user namespace per container unless the daemon runs with `userns-remap` or rootless. Either makes `systempaths=unconfined` safer still, because the container's root is then not the host's root; consider it on a shared host. If the AppArmor profile does not work on your host, read the denials with `sudo journalctl -k | grep 'apparmor="DENIED"'` and open an issue with them; `apparmor=unconfined` is the last resort and lifts every AppArmor restriction on the agent.

## Check it works

The example has a smoke test that you can run too. It starts Postgres, the office and one agent with dummy secrets and a one-person team, then waits for the office to be healthy and for the agent to connect. Then it starts the agent again with the subprocess sandbox and checks that too; on an AppArmor host it loads the agents' profile with `sudo` first, and skips that part with a notice when it cannot:

```sh
examples/compose/smoke.sh
```

The Examples workflow runs it, and `docker compose config` on the full file, for every pull request that touches `examples/`, `images/` or `packages/`.
