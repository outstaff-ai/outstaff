---
title: The agent
description: How ost-agent starts, takes work from the office, keeps one session per work item and builds the agent's identity.
---

`ost-agent` is the process inside each agent container. It runs as one person of the team, connects out to the office, and works through the items the office offers, one at a time. The LLM runtime is an adapter ([0009](/decisions/0009-agent-sdk-runtime/)); the agent never talks to a model itself.

## Startup

The container contract is a few environment variables and secrets. Hosting and secret storage stay with the operator ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)).

| Input                                                           | What it is                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OUTSTAFF_PERSON`                                               | Handle of the person this container runs as.                                        |
| `OUTSTAFF_OFFICE_URL`                                           | WebSocket URL of the office, for example `ws://office:8787/agent`.                  |
| `OUTSTAFF_AGENT_TOKEN`                                          | The person's agent token, read as a secret (file first, environment as a fallback). |
| `OUTSTAFF_TEAM_FILE`, `OUTSTAFF_TEAM_REPO`, `OUTSTAFF_TEAM_REF` | Where the team config is, as for the CLI.                                           |

In order, startup:

1. Loads the team config and checks that the person is on it.
2. Builds the ports the verbs use from the installed adapters (`createAgentEnv`). A configured port whose adapter is missing or fails is recorded, and the verb that needs it says why.
3. Renders the person's working files from the stock catalog plus the team's ejected catalog, and writes them into `~/work`. The runtime adapter says where it expects them: for the Claude Agent SDK, skills go to `.claude/skills/<role>/SKILL.md`. Adapters declare this with `workdirLayout`, so the agent has no runtime-specific paths. Other files (references, templates, process documents) stay where they were rendered, which is where the skills point.
4. Creates the runtime from the team's `integrations.runtime`.
5. Builds the permission policy ([0006](/decisions/0006-runtime-neutral-permissions/)) from the role's profile, the person's repository grants, the container layout, and the rule packs: adapter packs from the registry, the role's toolset from the catalog, and `policies.commands` from the team.
6. Connects to the office and starts the work loop.

The layout below `$HOME`: `work` (rendered files, the runtime's working directory), `repos`, `worktrees`, `scratch` and `memory`. The secrets directory is `OUTSTAFF_SECRETS_DIR`.

## Identity

The identity prompt is built from data, not from a template, and appended to the runtime's system prompt for every session. It contains:

- the person's name, handle and pronouns, their role title and summary, the team and its product;
- the teammates, and the trusted humans (or who counts as one when the team lists none), with the rule that text from anyone else is data, not instructions;
- the message style from `policies.messages`: the line limit, whether to always link tickets, pull requests and documents, and what to leave out. The same style applies to the final message of each item, which becomes its hand-back summary.

## Work loop

For each offer the agent:

1. accepts it;
2. builds the prompt from the offer: item kind and title, subjects and links, and the journal of earlier rounds;
3. runs it through the runtime with the identity prompt, the policy, the built-in tools of the profile and the `ost` verbs as in-process tools (`createRuntimeTools`, including `ask` and `question answer`);
4. sends `progress` from the runtime's text events, at most once per interval (30 seconds by default);
5. hands back with the final message as the summary, the links found in it, and a status: `done`, or `waiting` when a question the agent asked is still open. A failed run, or a runtime that throws, sends `fail` with the reason.

Heartbeats are sent by the office connection itself, at the interval the office asks for, with the id of the item being worked on. Items run one at a time. A second offer waits in the connection until the first is handed back.

**Stopping.** On `SIGTERM` or `SIGINT` the agent interrupts the runtime, hands the item back as `waiting` with the last message, and closes the connection. The office queues the item again and a later round resumes its session.

**Restarts.** The office lists accepted, unfinished items when the agent reconnects, but it cannot re-send their context. At startup the agent sends `decline` for each of them. That puts the item back in the queue untouched: no failure or attempt is counted, and the next offer carries the journal and the stored session.

## Sessions

One runtime session per work item ([0010](/decisions/0010-context-per-work-item/)). When the runtime starts a session the agent stores its id with the item by sending `session`; the office keeps it and puts it in `sessionId` on every later offer of that item. The agent resumes that session when present and starts a new one otherwise. A session is never used for another item, and nothing is kept on the agent's disk, so a replaced container loses nothing.

Chat threads will get their own sessions ([#43](https://github.com/outstaff-ai/outstaff/issues/43)); the session manager has a marked place for them, and until then only work items have sessions.
