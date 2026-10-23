---
title: Container contract
description: What a host needs to run the office and agent containers on any platform, and what each secret is for.
---

Outstaff does not host itself and does not store your secrets ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)). It publishes this contract, and you run the containers wherever you like: Docker Compose, Kubernetes, a managed container service. The secrets table below is generated from the adapters' own declarations (`pnpm --filter @outstaff/office run docs:contract`), so it matches the code of the version you read it for. The rest is written by hand.

A team runs one **office** container and one **agent** container per person.

## Images

| Image                        | Container                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `ghcr.io/outstaff-ai/office` | The office.                                                                                     |
| `ghcr.io/outstaff-ai/agent`  | An agent: the base system plus [mise](https://mise.jdx.dev/), which installs the agent's tools. |

These are the planned names; the images are tracked in [#45](https://github.com/outstaff-ai/outstaff/issues/45) and are not published yet. The catalog is baked into them. A client image extends one with `FROM` and `ost build`.

There is one agent image for every role. The tools a person needs are not in the image: at start the agent installs the toolsets of its role and the tools declared in `team.yaml` into `$HOME` with mise (see [Tools](/guides/tools/)). A team that wants no install at start, or no egress for it, can prebuild its own image with the tools instead.

Images never contain secrets. A client image that needs one at build time takes it with BuildKit `--secret`, never `ARG` or `ENV`, because both end up in the image history.

Docker is not assumed inside the containers: nothing in the office or the agent starts containers, and the images do not carry a Docker client.

## Secrets

Secrets are files first. Each container reads a secret named `KEY` from `/run/secrets/outstaff/KEY`, or from the directory in `OUTSTAFF_SECRETS_DIR`. Whoever puts the file there is up to you: Docker Compose `secrets:`, a mounted Kubernetes Secret, a cloud secret manager. Trailing whitespace is trimmed, and an empty file counts as missing.

Environment variables are only a fallback for platforms that can inject nothing else. A key is looked up as a file first, then in the environment.

:::caution
An agent's shell inherits its container's environment, so a secret passed as an environment variable is one `printenv` away. Outstaff removes every secret key it knows from the environment of the processes an agent can reach, but that only helps for keys it knows about, and not for every runtime credential (see below). Use files. Never put a secret in `environment:` of a Compose file or in a plain env entry of a Kubernetes pod.
:::

Some platforms mount secrets world-readable or as one root-owned file. The images run as a non-root user: make the files readable by that user and nobody else.

### Which container needs which secret

Required means the container does not work without it for a team that uses the adapter. Derivable means `ost setup --derive` can look the value up for you instead of you copying it. Where two keys are alternatives, such as a private key and the path of its file, one of them is enough.

<!-- contract:secrets:begin (generated, do not edit by hand) -->

| Key                              | Container | Required | Derivable | Agent shell can see it | What it is and where to get it                                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------- | -------- | --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OUTSTAFF_AGENT_TOKEN_<HANDLE>`  | office    | required | no        | no                     | One token per person, so the office accepts that agent's connection. The handle is upper case with `-` as `_`. Choose a long random value and give the same value to that agent as `OUTSTAFF_AGENT_TOKEN`.                                                                                                         |
| `OUTSTAFF_AGENT_TOKEN`           | agent     | required | no        | no                     | This person's token for the office, the same value the office holds as `OUTSTAFF_AGENT_TOKEN_<HANDLE>`.                                                                                                                                                                                                            |
| `ANTHROPIC_API_KEY`              | agent     | optional | no        | no                     | Anthropic API key. Use this, a cloud provider or a subscription token; the adapter itself never reads it. Anthropic Console. Give it to the container as an environment variable or secret file.                                                                                                                   |
| `CLAUDE_CODE_OAUTH_TOKEN`        | agent     | optional | no        | yes                    | Long-lived subscription token for this container. Use it within the provider's terms. Run `claude setup-token` on a machine signed in to your own subscription.                                                                                                                                                    |
| `GH_APP_ID`                      | agent     | required | no        | no                     | Numeric id of this person's own GitHub App. GitHub > Settings > Developer settings > GitHub Apps > your app > About.                                                                                                                                                                                               |
| `GH_APP_INSTALLATION_ID`         | agent     | required | yes       | no                     | Installation id of this person's own GitHub App on the team's account. The number in the installation URL, or let ost setup --derive look it up.                                                                                                                                                                   |
| `GH_APP_PRIVATE_KEY`             | agent     | required | no        | no                     | Private key (PEM text) of this person's own GitHub App; use this or GH_APP_PRIVATE_KEY_FILE. The App's page > Private keys > Generate a private key.                                                                                                                                                               |
| `GH_APP_PRIVATE_KEY_FILE`        | agent     | required | no        | no                     | Path to the private key PEM file, as an alternative to GH_APP_PRIVATE_KEY. The file downloaded when generating the key.                                                                                                                                                                                            |
| `GH_APP_SLUG`                    | agent     | required | yes       | no                     | URL slug of this person's own GitHub App (its bot is &lt;slug>[bot]). The App's public page URL, or let ost setup --derive look it up.                                                                                                                                                                             |
| `GH_OFFICE_APP_ID`               | both      | required | no        | no                     | Numeric id of the team's read-only office GitHub App. GitHub > Settings > Developer settings > GitHub Apps > the office app > About.                                                                                                                                                                               |
| `GH_OFFICE_APP_INSTALLATION_ID`  | both      | required | yes       | no                     | Installation id of the team's read-only office GitHub App on the team's account. The number in the installation URL, or let ost setup --derive look it up.                                                                                                                                                         |
| `GH_OFFICE_APP_PRIVATE_KEY`      | both      | required | no        | no                     | Private key (PEM text) of the team's read-only office GitHub App; use this or GH_OFFICE_APP_PRIVATE_KEY_FILE. The App's page > Private keys > Generate a private key.                                                                                                                                              |
| `GH_OFFICE_APP_PRIVATE_KEY_FILE` | both      | required | no        | no                     | Path to the private key PEM file, as an alternative to GH_OFFICE_APP_PRIVATE_KEY. The file downloaded when generating the key.                                                                                                                                                                                     |
| `GH_OFFICE_APP_SLUG`             | both      | required | yes       | no                     | URL slug of the team's read-only office GitHub App (its bot is &lt;slug>[bot]). The App's public page URL, or let ost setup --derive look it up.                                                                                                                                                                   |
| `ITSAPLAN_API_KEY`               | both      | required | no        | no                     | Office: API key of the member account the office acts as. Its a Plan > Account settings > API keys, signed in as that member (the key is shown once). Agent: API key of this agent's own member account in Its a Plan. Its a Plan > Account settings > API keys, signed in as that member (the key is shown once). |
| `SLACK_APP_TOKEN`                | agent     | required | no        | no                     | App-level token with connections:write, for Socket Mode (xapp-...). api.slack.com/apps > the app > Basic Information > App-Level Tokens.                                                                                                                                                                           |
| `SLACK_BOT_TOKEN`                | agent     | required | no        | no                     | Bot User OAuth Token of this person's Slack app (xoxb-...). api.slack.com/apps > the app > OAuth & Permissions.                                                                                                                                                                                                    |
| `SLACK_BOT_USER_ID`              | agent     | optional | yes       | no                     | Slack member id of this person's bot user. Let ost setup --derive look it up (auth.test), or the app's member profile.                                                                                                                                                                                             |

<!-- contract:secrets:end -->

The last column is the runtime's doing, not the table's: the Claude Agent SDK adapter starts the Claude Code binary with every key above removed from its environment, and sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the binary strips its own credentials from the Bash tool, hooks and stdio MCP servers. The documentation of that flag does not name `CLAUDE_CODE_OAUTH_TOKEN`, so with a subscription token the agent's shell may still see it. Narrow the token's reach and the container's egress ([below](#egress)) to make up for it.

The runtime adapter needs no credential of its own and declares both runtime keys optional: you supply exactly one way of signing in. Besides the two keys in the table, it passes these through from the secrets directory to the runtime, and scrubs them from the agent shell: `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_AUTH_TOKEN`. Provider settings that are not secret (`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION` and similar) are plain environment variables. Credentials belong to you: Outstaff never asks for, stores or brokers them ([0009](/decisions/0009-agent-sdk-runtime/)).

## Environment variables

### Office

| Variable                | Default                                | Meaning                                                                             |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `OUTSTAFF_TEAM_FILE`    | none                                   | Path to `team.yaml`, or the folder holding it. Wins over `OUTSTAFF_TEAM_REPO`.      |
| `OUTSTAFF_TEAM_REPO`    | none                                   | Git URL of the repository that holds `.outstaff/team.yaml`.                         |
| `OUTSTAFF_TEAM_REF`     | the default branch                     | Branch, tag or commit of `OUTSTAFF_TEAM_REPO`.                                      |
| `OUTSTAFF_STORE_URL`    | `sqlite:///var/lib/outstaff/office.db` | `postgres://user:pass@host/db`, `sqlite:///path` or `sqlite::memory:` (tests only). |
| `OUTSTAFF_AGENT_PORT`   | `8080`                                 | Port agents connect to, path `/agent`.                                              |
| `OUTSTAFF_HEALTH_PORT`  | `8081`                                 | Port of the health endpoints.                                                       |
| `OUTSTAFF_WEBHOOK_PORT` | `8082`                                 | Port of the webhook receiver, used when the team's `office.events` is `webhook`.    |
| `OUTSTAFF_SECRETS_DIR`  | `/run/secrets/outstaff`                | Directory of secret files.                                                          |

If none of the team variables is set, the office looks for `.outstaff/team.yaml` or `team.yaml` in its working directory. A store URL with a password is a secret too: prefer a platform feature that fills the variable from a secret store over writing it into a manifest.

### Agent

| Variable                                                        | Default                 | Meaning                                                                |
| --------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `OUTSTAFF_PERSON`                                               | required                | Handle of the person this container runs as.                           |
| `OUTSTAFF_OFFICE_URL`                                           | required                | WebSocket URL of the office, for example `ws://office:8080/agent`.     |
| `OUTSTAFF_TEAM_FILE`, `OUTSTAFF_TEAM_REPO`, `OUTSTAFF_TEAM_REF` | as for the office       | Where the team config is. The agent reads the same team as the office. |
| `OUTSTAFF_SECRETS_DIR`                                          | `/run/secrets/outstaff` | Directory of secret files.                                             |
| `HOME`                                                          | the user's home         | Root of the agent's directories, see [volumes](#volumes).              |

The office URL is the only address an agent needs. Use `wss://` when the connection crosses a network you do not control; Outstaff does not terminate TLS itself.

## Volumes

| Container | Path                                           | What it holds                                                                                  | Keep it?                                                     |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| office    | `/var/lib/outstaff`                            | The SQLite store, when `OUTSTAFF_STORE_URL` is not set. The folder is created when missing.    | Yes, unless you use Postgres, which needs no volume.         |
| agent     | `$HOME/repos`                                  | Clones of the repositories the person may read or write.                                       | Optional; a cache that is cloned again when missing.         |
| agent     | `$HOME/worktrees`                              | One git worktree per work item.                                                                | Yes, if unpushed work should survive a restart.              |
| agent     | `$HOME/memory`                                 | The person's notes between work items.                                                         | Yes.                                                         |
| agent     | `$HOME/scratch`                                | Throwaway files.                                                                               | No.                                                          |
| agent     | `$HOME/work`                                   | The person's rendered working files (skills, references, templates), written on every start.   | No.                                                          |
| agent     | `$HOME/.local/share/mise`, `$HOME/.cache/mise` | The tools installed from the declared toolsets and `tools:` (mise data and cache directories). | Yes. The first start installs them, later starts reuse them. |
| both      | `$HOME/.cache/outstaff/teams`                  | Clone of the team repository when `OUTSTAFF_TEAM_REPO` is used (`XDG_CACHE_HOME` moves it).    | No.                                                          |

The agent's own directories are all below `$HOME`, so mount that writable if you run with a read-only root filesystem. The agent keeps no session or journal on its own disk: the office stores both, and a replaced container resumes from them. What a lost volume costs is work that was never pushed, which is why `worktrees` is worth keeping.

## Ports

| Container | Port                             | Purpose                                                                                                                                                                                                                 |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| office    | `8080` (`OUTSTAFF_AGENT_PORT`)   | Agent connections, WebSocket on `/agent`. Reachable by the agents only; do not publish it.                                                                                                                              |
| office    | `8081` (`OUTSTAFF_HEALTH_PORT`)  | `GET /healthz` and `GET /readyz`. For the platform's probes only.                                                                                                                                                       |
| office    | `8082` (`OUTSTAFF_WEBHOOK_PORT`) | `POST /webhooks/vcs` and `POST /webhooks/tracker`, only when the team receives webhooks. This is the one port that may need to be reachable from the code host and the tracker. Every request is verified by signature. |
| agent     | none                             | Agents connect out to the office and listen on nothing.                                                                                                                                                                 |

## Health and readiness

The office answers on the health port with JSON such as `{ "ok": true, "state": "running", "components": { … } }`.

- `GET /healthz` is liveness: 200 while the office is starting or running with its parts up (store, agent connection, work state, intake, scheduler), 503 once a part fails or the office is stopping. Let the platform restart the container on 503.
- `GET /readyz` is readiness: 200 only while the office is running. Send traffic when it is 200.

The liveness endpoint answers while the office starts, so a slow first rescan is not mistaken for a hang; give the startup probe a generous window.

The agent has no endpoint. It exits non-zero when it cannot start or when the office rejects its token, and reconnects with backoff when the connection drops, so a restart policy of "on failure" fits. A start that fails prints its reason on stderr (an unset variable, an invalid team config, a person who is not on the team).

Both containers log one line per event to stdout (office, JSON) or stderr (agent).

## Shutdown

Both containers stop on `SIGTERM` and on `SIGINT`, and exit 0 when they stopped cleanly.

- **Office:** stops intake, lets the handlers that are running finish, closes the agent connections and the store, then exits. Give the platform's grace period enough time for that; 30 seconds is a sensible floor. Events that were recorded but not handled are handled on the next start; handlers are idempotent, so a repeat does no harm.
- **Agent:** interrupts the runtime and hands the work item back as `waiting` with the last message, then closes its connection. The office queues the item again and a later round resumes the same session. A run that was cut off without that, because the container was killed or crashed, is also retried: the restarted agent declines the items it had accepted, which puts them back in the queue without counting a failure.

Rolling either container is therefore safe at any moment.

## Resources

The first start of an agent takes longer than later ones, because it installs its tools; allow for it in the startup probe or grace period. These are starting points, not measurements. Watch the real use for a week and adjust.

| Role                        | CPU      | Memory        | Notes                                                                                          |
| --------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Office                      | 0.5 vCPU | 512 MiB       | Mostly waiting on the network. Memory grows with the number of live tickets and pull requests. |
| Agent (base)                | 1 vCPU   | 2 GiB         | One work item at a time: the runtime process, git and `ost`.                                   |
| Agent that builds and tests | 2 vCPU   | 4 GiB or more | Size it for the biggest build or test run of your repositories, not for the agent.             |

Give the volumes room for the installed tools and the clones and worktrees of every repository the person works in, and set a limit on the scratch space so one runaway job cannot fill the node.

## Egress

Allow what a container needs and block the rest. An agent can run shell commands, and both Node and Python open sockets without any tool the permission rules know about, so a rule on commands alone does not keep a secret from leaving. Egress rules are the layer that does.

| Container | Allow outbound HTTPS (and git over HTTPS) to                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| office    | The code host (for GitHub, `api.github.com` and `github.com`), the tracker, and the team repository if `OUTSTAFF_TEAM_REPO` is used. The chat service too, when the team's chat adapter needs office credentials. |
| agent     | The office. The LLM provider (`api.anthropic.com`, or your Bedrock, Vertex AI or Foundry endpoint). The code host, the tracker and the chat service (for Slack, its API and the Socket Mode endpoints).           |

Agents also need the **tool sources**: the registries and release hosts of the tools the team declares. They are only needed on the first start and when a declared version changes, because later starts reuse the installed tools on the home volume. A team that prebuilds its image with the tools can leave them blocked.

Everything else stays blocked, including package registries unless the agent's work needs them; if it does, allow the registry hosts you name and nothing broader.
