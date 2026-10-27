---
title: The agent
description: How ost-agent starts, takes work from the office, keeps one session, worktree and journal per work item and builds the agent's identity.
---

`ost-agent` is the process inside each agent container. It runs as one person of the team, connects out to the office, and works through the items the office offers: one work item at a time, and chat sessions beside it. The LLM runtime is an adapter ([0009](/decisions/0009-agent-sdk-runtime/)); the agent never talks to a model itself.

## Startup

The [container contract](/reference/container-contract/) is a few environment variables and secrets. Hosting and secret storage stay with the operator ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)).

| Input                                                           | What it is                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OUTSTAFF_PERSON`                                               | Handle of the person this container runs as.                                        |
| `OUTSTAFF_OFFICE_URL`                                           | WebSocket URL of the office, for example `ws://office:8080/agent`.                  |
| `OUTSTAFF_AGENT_TOKEN`                                          | The person's agent token, read as a secret (file first, environment as a fallback). |
| `OUTSTAFF_TEAM_FILE`, `OUTSTAFF_TEAM_REPO`, `OUTSTAFF_TEAM_REF` | Where the team config is, as for the CLI.                                           |

In order, startup:

1. Loads the team config and checks that the person is on it.
2. Builds the ports the verbs use from the installed adapters (`createAgentEnv`). A configured port whose adapter is missing or fails is recorded, and the verb that needs it says why.
3. Renders the person's working files from the stock catalog plus the team's ejected catalog, and writes them into `~/work`. The runtime adapter says where it expects them: for the Claude Agent SDK, skills go to `.claude/skills/<role>/SKILL.md`. Adapters declare this with `workdirLayout`, so the agent has no runtime-specific paths. Other files (references, templates, process documents) stay where they were rendered, which is where the skills point.
4. Creates the runtime the person runs on: their own `people[].runtime`, else the team's `integrations.runtime` (see [Runtimes](/guides/runtimes/)). It stops with an error naming the person when this build does not carry that runtime adapter, or when the adapter cannot enforce a permission policy (`runtime.permissions`), and logs `runtime selected` with the person, the runtime adapter and the model. Every part of startup that reads `integrations.runtime` (the working-file layout, the runtime's rule pack, the Design canvas) sees the person's runtime; the canvas is on only when that runtime provides `design.canvas`.
5. Builds the permission policy ([0006](/decisions/0006-runtime-neutral-permissions/), [0015](/decisions/0015-allow-by-default-in-the-sandbox/)) from the role's profile, the person's repository grants, the container layout, and the rule packs: adapter packs from the registry, the role's toolset and tool declarations, and `policies.commands` from the team. Anything no rule denies is allowed; see [permissions](/guides/permissions/).
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
2. for a `review_feedback` or `merged_feedback` item, reacts with `eyes` on the code host (see [Acknowledgements](#acknowledgements));
3. builds the prompt from the offer: item kind and title, subjects and links, and the journal of earlier rounds;
4. runs it through the runtime with the identity prompt, the policy, the built-in tools of the profile and the `ost` verbs as in-process tools (`createRuntimeTools`, including `ask` and `question answer`);
5. sends `progress` from the runtime's text events, at most once per interval (30 seconds by default);
6. appends a journal entry (see [Journal](#journal));
7. hands back with the final message as the summary, the links found in it, and a status: `done`, or `waiting` when a question the agent asked is still open. A failed run, or a runtime that throws, sends `fail` with the reason.

Heartbeats are sent by the office connection itself, at the interval the office asks for, with the id of the item being worked on. Work items run one at a time; a second offer waits until the first is handed back. Chat sessions run beside the work item, each with its own heartbeat, up to the office's limit (`policies.chat.parallel_sessions`).

**Stopping.** On `SIGTERM` or `SIGINT` the agent interrupts the runtime, hands the item back as `interrupted` with the last message, and closes the connection. The office queues the item first with its session; the next offer says the previous run was interrupted, and the session resumes.

**Restarts.** The office lists accepted, unfinished items when the agent reconnects, but it cannot re-send their context. At startup the agent sends `decline` for each of them. That puts the item back in the queue untouched: no failure or attempt is counted, and the next offer carries the journal and the stored session.

## Acknowledgements

Every surface shows that the agent took a request before it answers, with the same `eyes` reaction:

| Surface   | Where the acknowledgement appears                                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat      | An `eyes` reaction on the person's message, added by the chat relay as soon as the message arrives (see [Chat](#chat)).                                                                                                                                                                                                                                              |
| Code host | An `eyes` reaction on each comment that triggered a `review_feedback` or `merged_feedback` item: the comment itself for a comment on the pull request conversation or an inline comment, and every inline comment of a submitted review. The host has no reactions on a review body, so a review with only a summary gets none; its reply comes when the round ends. |

The agent runner adds the code host reaction when it accepts the offer, before the run starts, not the model, so it always happens and costs no tokens. It acts as the person, with the agent's own `Vcs` port (the person's own App, which has Pull requests and Issues write); the office's App is read-only. The comment ids come from the feedback in the offer. The same reaction is never added twice to one comment, and a failure (for example a comment that was deleted meanwhile) is logged as a warning and never blocks the round.

## Usage

The runtime knows how close the person's LLM subscription is to its limits; the office does not. The agent forwards that to the office with the `usage` message so the [usage policy](/architecture/office/#usage-policy) can hold automatic work:

- Every usage event of a running item is forwarded, but at most once a minute. A report that would be skipped is held and sent when the item ends. A report that moves the busiest window across `policies.usage.defer_scheduled_at` or `pause_automatic_at`, up or down, is sent at once.
- While no item is running the agent asks the runtime's `probeUsage` (capability `runtime.usage`) when it connects and then every 10 minutes (`usageProbeEveryMs`), and forwards the result. A runtime without it only reports during work.
- A failed report is logged and dropped; the next one replaces it.

## Sessions

One runtime session per work item ([0010](/decisions/0010-context-per-work-item/)). When the runtime starts a session the agent stores its id with the item by sending `session`; the office keeps it and puts it in `sessionId` on every later offer of that item. The agent resumes that session when present and starts a new one otherwise. A session is never used for another item, and nothing is kept on the agent's disk, so a replaced container loses nothing.

**A lost session.** The runtime adapter marks a failed run as `sessionLost` when it was asked to resume a session the runtime no longer knows (unknown or expired; the Claude Agent SDK adapter recognizes "No conversation found"). The agent then:

1. appends the journal note "Session restarted from journal: the stored session could not be resumed.";
2. starts a new session for the same item with a prompt that says so and carries the same journal and current state as every offer: subjects with their links and status, and the journal of earlier rounds;
3. stores the new session id with the item, replacing the lost one.

It never starts from nothing silently, and it restarts once: if the new session fails too, the item fails as usual.

A chat session has a second kind of key, the thread (`thread:<channel>:<thread>`). The chat sessions of one thread, the first and a follow-up after it was done, share one session; the office stores it with the item like any other and carries it over to the next session of the thread. A thread session is never used for an item that did not come from that thread, and an item session is never used for a thread. Work a chat session filed has the thread's origin too, but runs under other permissions at the same time, so it has a session of its own.

## Chat

Each agent listens on its own chat identity: the chat adapter is created in the agent container from the person's secrets, and `chat.start` hands every message to the chat relay (`createChatRelay`). The adapter applies the trust filter and the relay checks again: a message from anyone but a trusted human, and any message from a bot, is dropped before it reaches the office. Direct messages and mentions are the requests; nothing else is read.

For each message the relay reacts with `eyes`, sends `chat_message` to the office, and posts the answer in the message's thread:

| The office says | The agent posts                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`       | Nothing; a chat session starts at once, beside the active work item, and the `eyes` reaction shows the message was seen. The answer comes from the session (below). |
| `limited`       | Briefly, that all chat sessions are taken and this message is next in line.                                                                                         |
| `placed`        | Where the request went.                                                                                                                                             |
| `asked_pm`      | That the PM was asked, and that it waits until the human says where it goes.                                                                                        |
| `unclear`       | The question again, with the list.                                                                                                                                  |
| `joined`        | Nothing. The message is in the journal of the item of the thread and the item sees it on its next round.                                                            |

A message the office already handled (`repeated`) gets no second answer, so a redelivery by the chat platform does not post twice. If the office cannot be reached the relay says so in the thread, since the adapter has already marked the message as seen.

**Chat sessions.** A message is not a work item. The office starts a chat session for it at once, even while a work item runs, and the loop runs it beside that item with its own runtime session, its own heartbeat and a permission profile of its own (`chat`): it has the tools of a work session and runs commands such as the tests, but it edits no repository file, has no worktree, pushes nothing, and calls only the `ost` verbs `me`, `team`, `work`, `work queue`, `work attach`, `doc search`, `doc show`, `ticket show`, `ticket comment`, `ticket create`, `ticket attach`, `pr status`, `pr checks`, `pr threads`, `pr conversation`, `pr diff` and `pr comment`. The profile is compiled into the policy, so the runtime's permission hook refuses anything else whatever the prompt says; the rule packs of the role's own profile apply to it. The session decides what the message is. A question or a discussion is answered in its final message, which is posted in the thread. Work is filed: `ost ticket create` with a tracker (`work_link`), `ost work queue` without one (`work_queue`). A message with several requests is filed as several tickets, one per request; filing the same request again is refused before anything is created. The office creates the work item in the same thread, and the relay posts "On it. Tracked in <ticket>" there, once. When the person is busy it adds the question where the work goes: the current work as the grouped list, and next, after one of the lines, last, or the PM. The session then ends without a result post; the work item reports its own result. A request about work the agent already has is not filed again: `ost work attach <ticket|pr>` makes it a round on that work (the human's message is its feedback) and the first reply reads `Adding this to [PR #11](link) for [ACME-11](link)`. A pull request in review is not attached on the session's own say-so: the session asks in the thread whether it belongs there or is a follow-up, and passes `--confirmed` after the human answers; merged or done work is always a follow-up.

**Context.** A new chat session, one without a stored session, starts with the last messages of the conversation (the thread, and the messages before it in the same direct message or channel; 10 by default, from the adapter's `history`) and the person's current work (the grouped work list, and `current_work` to the office: tickets and pull requests with status, CI and review). Text from anyone but a trusted human is marked as data. A resumed session already knows the conversation; what was said in the thread since is in the item's journal. A session restarted after a lost one gets the conversation again, like any new chat session. Chat sessions go through the same rounds as all items, so they also get the lost-session restart and the journal entry on hand-back; the report to the requester comes after that journal step.

**Report back.** When an item with a chat origin ends, the agent asks the office with `chat_report` whether to post, and the office grants each ending once. The post goes to the thread the request came from and mentions the requester (`<@id>`, which the adapter turns into a mention):

- **Done.** The final message of the item, in full (the agent is asked to keep it to about `policies.messages.max_lines` lines, and a reply over a safety cap of 40 lines is split into several messages in the thread, never cut), followed by links the message does not contain: the pull request, the ticket, documents. The links come from the hand-back and from the office, which knows the item's ticket (if there is one) and the pull requests that implement it.
- **Failed.** One short note that it could not finish and will be tried again. The next failure of the same item stays quiet.
- **Blocked.** What is needed, with the links. An item the scheduler blocks (stale twice, loop guard) is reported by the office itself.
- **Waiting.** Nothing. An item that waits for a teammate's answer, a shutdown hand-back, and the review rounds and questions that grow out of the request report nothing; the requester hears when the requester's own item finishes.

`ost work move <id> next|last|before|after [other]` puts a queued item at a place in the agent's queue. The requester's answer in the thread normally does that without the agent.

## Journal

Every hand-back (done, waiting, or stopped by a shutdown) is preceded by a short structured entry in the item's journal, which the office stores and puts in the context of every later offer. For a finished run the agent asks the runtime for it with one more turn in the same session, without tools:

```
Done: what you did this round.
Decisions: what you decided and why, or none.
Open: what is still open or what you wait for, or none.
Links: the pull requests, documents and tickets involved, or none.
```

If the answer does not follow the format, or the extra turn fails, the entry is built from the final message and its links instead, so a hand-back never goes without one. When the agent stops for a shutdown it does not ask the runtime again; it uses the last message. A journal entry that cannot be stored is logged and does not hold back the hand-back. The office also records the hand-back summary itself and the progress lines, so the journal reads as the full history of the item.

## Memory

`~/memory` is per person, shared by all items, and holds lasting lessons only ([0010](/decisions/0010-context-per-work-item/)). The agent process never writes there: item details go to the journal, and memory changes only when the model itself writes a file with its tools. The directory is one of the runtime's added directories and the policy allows writes to it, to scratch and to granted repositories, and nowhere else in the layout.

## Repositories and credentials

**Cloning.** At startup the agent clones every team repository the person has a grant on into `~/repos/<name>`, or fetches it when the clone is already there. A repository without a grant is never cloned. A repository that cannot be reached is logged and skipped; the others carry on.

**Credentials never sit in the environment or on disk.** Git does not get a token from `GH_TOKEN`, `GITHUB_TOKEN` or a stored file (Claude Code deliberately keeps those two variables when it scrubs subprocess environments, so the agent never relies on them). Each clone is configured with a credential helper, `ost git-credential`. When git needs to authenticate, the helper reads git's request on standard input, finds the team repository it is for, and asks the VCS adapter for a short-lived token for that one repository at the access the person's grant gives. `store` and `erase` do nothing. The clone also resets the helper list first, so a keychain or other global helper never sees the token. Pull request operations go through the `ost pr` verbs, not a `gh` that holds a token.

**Secrets for the helper are files.** Git starts the helper from inside the agent's shell, where Claude Code's subprocess scrub has removed credential-looking variables. So the helper depends only on non-secret environment (`OUTSTAFF_PERSON`, `OUTSTAFF_TEAM_FILE`, `OUTSTAFF_TEAM_REPO`, `OUTSTAFF_TEAM_REF`, `OUTSTAFF_SECRETS_DIR`, `HOME`) and reads every secret it needs, such as the App keys, from files in the secrets directory. It does not fall back to the environment. If a file is missing it fails with: secrets must be provided as files under the secrets directory; env-only secrets are not visible to git's credential helper. Operators therefore mount the secrets they give an agent container as files (the container contract's secrets directory), not only as environment variables.

**The role profile caps the access.** The token is never more than the person's role profile allows. The `readonly` profile gets read tokens even with a write grant, and its clones are read-only for the `pre-push` hook too; `docs`, `code` and `infra` follow the grant (a docs role's file-level limits are enforced by the policy's path rules). Whether a profile honours write grants comes from one place, the profile specs in core. The clone and the helper use the same cap.

**The agent can see a token.** The agent can run `ost git-credential get` itself and read the token. That token is scoped to one repository, at the person's capped grant, and short-lived, so it gives no more than `git push` with the helper already can. Keeping it inside the container is the job of the egress rules, not of the helper.

**Identity.** A write grant uses the person's own App: commits and pushes come from the person's bot, and `user.name` and `user.email` of the clone are taken from the author the credentials report. A read grant uses the office's read-only App, which holds no write permission on any repository.

**Why read access exists.** An agent that reviews, plans or writes documents needs to read code it may not change: the design system a feature follows, the infrastructure repository behind a question, a baseline it must stay compatible with. Giving each person a write App on all of those would be far too much. The safeguards:

- the token comes from a read-only App and is limited to one repository and the `contents: read` permission;
- the person's grant must cover the repository, and the policy treats the clone as read-only (no commit-changing git commands are allowed in it);
- a `pre-push` hook in the clone refuses every push from a read repository;
- what the agent reads there is data, not instructions, like any text that did not come from a trusted human.

Of these, the token is the boundary. The policy lets an agent run any program ([0015](/decisions/0015-allow-by-default-in-the-sandbox/)), so the policy and the hook guard against mistakes and talked-into pushes, while the read-only App is what makes a push from a read repository fail at the code host. An operator who gives read grants must keep the office's App read-only, and keep egress to the code host limited to what the agents need ([where the boundary sits](/guides/permissions/#where-the-boundary-sits)).

**Never the default branch.** The policy already denies pushing to a repository's default branch. As defence in depth every writable clone also has a `pre-push` hook that refuses it. The token's scope is the last line: branch protection on the host is still the client's job.

**Worktree per work item** ([0010](/decisions/0010-context-per-work-item/)). Before each item the agent fetches the repository the item concerns (the one a subject or link names, otherwise the primary repository, otherwise the first one the person may write). Then:

1. On the first round it creates a worktree at `~/worktrees/<repo>/<item>` detached at the up-to-date default branch. Outstaff creates and names no branch for new work: the agent creates its own with `git switch -c`, named by the repository's conventions (default `<type>/<ticket key>-<short slug>`), once it has identified the work, and `ost pr open` refuses a detached HEAD. An item that ends without code changes leaves no branch. An item about an open pull request the person opened (the item's subject, or the only such pull request of its ticket) works on that pull request's head branch instead: the worktree checks out `origin/<head>` into a local branch of the same name, and the prompt tells the agent to push there. The office sends `headRef`, `baseRef`, `state` and `own` on each pull request subject. A follow-up after a merge starts detached from the default branch again. The worktree sits below `~/worktrees/<repo>` because that is where the permission policy allows writes.
2. On later rounds it reuses the same worktree, with the unfinished work still in it.
3. When the item is handed back as `done`, the worktree and the scratch directory `~/scratch/<item>` are removed. An item that is `waiting` or blocked keeps both. The branch is never deleted, so commits that were not merged are not lost.

The worktree and scratch directory are added to the runtime's directories, and the prompt names them. The runtime's working directory stays `~/work`, where the rendered skills are.

**The repository's own conventions.** How work is done in a repository (commit count and format, branch names, the pull request title and body, which tests to run) is the repository's choice, not Outstaff's. The prompt lists the convention files found in the worktree (`CONTRIBUTING.md`, `AGENTS.md`, `.github/CONTRIBUTING.md`, `docs/CONTRIBUTING.md`, `.github/pull_request_template.md`) plus the files `repos[].instructions` names, and tells the agent to read them before it changes anything. The catalog only states defaults for when the repository says nothing. A project `CLAUDE.md` is not loaded into an agent session: the repositories and worktrees are added directories, and Claude Code loads `CLAUDE.md` from those only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set, which the runtime removes from the session environment. The working directory keeps its own project settings. A file in `repos[].instructions` is read because the prompt names it. See [Tell your agents how your repo works](/guides/repo-conventions/).
