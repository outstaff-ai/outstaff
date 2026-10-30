---
title: The office
description: How the office takes in events, tracks work and schedules agents.
---

The office is one long-running process per team. It owns the store, talks to integrations only through adapters, and talks to agents only over the agent protocol. Each component below has its own section.

## How an event flows

```text
code host, tracker, docs --> intake --> work state --+    chat.message (passed on by the agent)
                                         |           |    skips the work state
                   pr.conflicted,        |           v
                   pr.ci_failed ---------+---> judge the event <--- agent.started, agent.handed_back,
                                                     |               agent.idle (raised by the office)
                     the event pipeline decides, and traces why
                                                     |
                   +---------------------------------+------------------------------+
                   v                                 v                              v
                 wake                               act                           drop
       the scheduler queues a work      the agent's process changes the       the reason is on
       item (coalesced)                 tracker as itself, no model run       the trace
                   |
                   v
       the agent connection offers the item with its journal and wake context
```

[Intake](#intake) records each event once and hands it on in order; the [work state](#work-state) applies it and raises the events no platform sends; the [event pipeline](#event-pipeline) decides; the [scheduler](#scheduler) runs the work; the [agent connection](#agent-connection) offers it with its [wake context](#wake-context). [What outstaff does on its own](/concepts/automation/) explains the decisions and the default policies from a team's point of view.

## Intake

Intake turns activity in your repositories, tracker, knowledge base and chat into deduplicated, normalized events for the work state and the event pipeline.

### Modes

`office.events` in the team config selects the mode.

- **poll** (default). Every `office.poll_interval_seconds` the office asks the VCS adapter for events across all team repos and, if a tracker is configured, the tracker adapter. Each source polls on its own timer.
- **webhook**. The office listens for `POST /webhooks/vcs` and `POST /webhooks/tracker`. The adapter verifies the signature and parses the body; intake only does the HTTP. A bad signature gets `401`, a malformed body `400`, a source without adapter support `404`, an oversized body `413`. Adapters opt in by implementing the optional `parseWebhook(headers, body)` method of their port.

### What the logs say

Intake and the pipeline log at info level by default, so "the agent did not react" can be answered from the logs; `ost explain <event-id>` answers it in full. Feeds are re-read with a 5-minute overlap, so the same events come back on every poll; those repeats are kept out of the info level.

- `intake: recorded <source> <type> on <repo#n or ticket> by <actor> (trusted|untrusted)` for every event kept. Info.
- `intake: dropped <source> <type> on <subject>: <reason>` for every event read but not kept. The reason is that the adapter does not map the event type, that the office does not map it (for example `pr.synchronize`), or that it is a duplicate.
  - An unmapped event (either reason) is logged at info the first time per event id, then at debug. The office remembers ids in memory for the overlap window, so after a restart a repeat can show at info once more.
  - A duplicate of an event already recorded is always debug.
- `pipeline: queued work item <id> for sam (review_feedback)` for each wake, or `pipeline: folded the wake into work item <id> for sam (review_feedback)` when it joined an item that is queued or running, or held in its [coalescing](#coalescing) window. The pipeline's other decisions are on the trace, not in the log. A `pipeline.policies` entry the office cannot use is a warning at start (`pipeline: pipeline.policies.<id>: ...`).
- `queued follow-up work item <id> for sam: 1 new feedback after <id> was offered` after a hand-back, when feedback was attached to the item after the agent was offered it, and `closed blocked work item <id>, <id> finished ACME-12` when finished work makes an earlier blocked item moot.
- A failed poll is an error. When a polled source has had no successful poll for `office.poll_warn_after_minutes` (default 10), each further failure also logs a warning with the minutes.

| Level | Lines                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| debug | duplicates of recorded events; unmapped events after their first sighting                                                              |
| info  | recorded events; first sighting of an unmapped event; pipeline wakes; follow-up rounds; baseline set                                   |
| warn  | effects not applied; failing event handlers (before they are given up on); polls with no success past `office.poll_warn_after_minutes` |
| error | failed polls; failed event delivery; events given up on                                                                                |

The office writes `info` and above. Set `OUTSTAFF_LOG_LEVEL` to `debug` to see the repeats as well (`info`, `warn` or `error` are the other values).

Logs never carry message or comment bodies; error text is cut to a short length.

### Cursors, dedupe and restarts

Each source keeps an opaque cursor in the store and sends it with the next poll, so a restart resumes where it stopped. The cursor only moves after the whole page was recorded. Every event is also recorded by `(source, externalId)`; a repeat is dropped. So a crash mid-page, a replayed page or a webhook redelivery never produces a second event.

**First poll.** A source with no stored cursor returns its recent history, which is not news. Intake therefore sets a baseline: it stores the cursor of that first page, records and delivers none of its events, and logs `intake: baseline set for <source>`. Later polls process only what happened after it, and a restart with a stored cursor does not baseline again. Existing tickets and pull requests are not picked up on first start; the work begins when one is assigned or moved. Webhook mode has no baseline, because deliveries are live events and poll mode never runs beside it.

### Delivery is at-least-once

An event is recorded first, then handed to the handlers registered with `onEvent`, then marked processed. If a handler throws, the event stays unprocessed and is retried with the same backoff as polling, up to 5 attempts (`maxAttempts`); after that the error is logged and the event is marked processed with the error, so one poisoned event cannot block the rest. Events are always delivered in order: later events wait behind a failing one. On start, intake first redelivers everything still unprocessed. Handlers therefore **must be idempotent**: the same event can reach them more than once, and when several handlers are registered a retry reruns all of them.

### Failures

A failed poll never stops the loop.

- `rate_limited` waits for the adapter's `retryAfterMs` (capped at 5 minutes), or backs off exponentially when none is given.
- `unavailable` and any other error back off exponentially from 1 second up to 5 minutes.
- A success returns to the normal interval.

### Normalized events

| Source event                               | Event                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| pull request opened, merged, closed        | `pr.opened`, `pr.merged`, `pr.closed`                                                                                            |
| review submitted                           | `pr.review_submitted` (`data.state`)                                                                                             |
| pull request comment                       | `pr.comment` (`data.kind`: `comment` or `review_comment`)                                                                        |
| ticket created, assigned, moved, commented | `ticket.created`, `ticket.assigned`, `ticket.moved` (`data.from`, `data.to`, `data.fromName`, `data.toName`), `ticket.commented` |
| comment or reply on a document             | `doc.commented` (`data.docId`, `data.anchorText`, `data.commentId`)                                                              |

An inline comment that belongs to a review (`data.reviewId`) is recorded but neither starts work nor changes the work state: GitHub announces each comment of a batch review as it is written, while the review is still pending and invisible to everyone but its author. The review starts the round when it is submitted, and intake reads its inline comments with their review thread ids (the port's `reviewComments`) into `data.comments`, so the `review_feedback` item carries all of them and a review with inline comments is never taken for a bare sign-off. GitHub also creates a submitted review for a single comment or a thread reply, so the review event covers every inline case. Comments on the conversation (`kind: comment`) start work as before.

Document comments have no webhook and are not in the tracker's feed, so the office polls them from the knowledge base, in poll and webhook mode alike. It reads the comments of the documents agents wrote for open work (`ost doc create` and `ost doc update` tell the office which work item a document belongs to; the work state keeps the document, its author and its ticket), at most 25 documents per poll, the most recently active first, with the same overlap and de-duplication as the other feeds. It needs a `knowledge` integration whose adapter can read them and the switch `policies.feedback.doc_comments`; otherwise nothing is read.

A move carries canonical statuses: intake turns the tracker's status names into them through `workflow.statuses`, so `data.from` and `data.to` are, for example, `ready` and `active`, and the names stay in `data.fromName` and `data.toName` (`Ready`, `In Progress`). A name the map does not know leaves only the name, so a `moved_to` condition does not hold for it and says the status is unmapped.

Pushes to a pull request are not forwarded; `pr.conflicted` and `pr.ci_failed` come from the work state, not from intake. Every event carries `data.at`, the time the source reported.

A chat message is not read from a source: the agent the message was written to passes it on (see [Chat requests and report-back](#chat-requests-and-report-back)). Intake records it with `receive` as `chat.message`, source `chat`, id `<agent>:<channel>:<message id>`, and delivers it with the other events, in order and at least once. Its subject is the conversation: the thread of a reply or of a top-level message in a channel, and the whole direct message for its top-level messages, so quick follow-ups are one conversation. The actor is the human who wrote it (the agent passes on only trusted humans' messages), and `data` has the text (`body`), the agent it was written to (`addressed`) and the message itself. The work state never sees it; only the [event pipeline](#event-pipeline) judges it.

### Who acted, and whether to trust them

Each event has an actor kind.

- **agent**: the VCS login matches a person's `identities.vcs` exactly (ignoring case), or the tracker member's id or username equals the person's `identities.tracker`. Nothing else makes an actor an agent, however its name looks, so an outside account cannot pass as one of your agents by naming itself after one. A person with a write grant but no `identities.vcs` triggers the `people.missing_vcs_identity` warning: their pull requests and comments are treated as an unknown human's.
- **automation**: any other login ending in `[bot]`, or a tracker member of kind `agent` that is not a team person.
- **human**: everyone else. A human is trusted when they have `write` or `admin` permission on the repository (looked up with `vcs.permission` and cached in the store for 10 minutes), or are listed in `humans:` when that list exists. Tracker members of kind `human` are trusted.

Events from untrusted humans are still recorded and delivered, but carry `data.untrusted: true` (and `meta.trusted === false` in the handler) so the pipeline never treats them as instructions: it drops them with that reason on the trace.

### Using it

```ts
const intake = createIntake({ store, ports: { vcs, tracker }, team, clock, logger });
intake.onEvent((event, meta) => pipeline.handle(event, meta));
await intake.start();
```

The clock is injected, so tests drive the poll loop deterministically.

## Scheduler

The scheduler decides which work item each person runs next. It keeps no state of its own: the queue, positions, loop-guard counts and pauses live in the store, so a restart rebuilds it from there. Time comes from an injected clock, and the policy rules are pure functions that are tested apart from the store.

### Priority

Lower numbers run first. The class comes from what triggered the item:

| Priority | Class                                              |
| -------- | -------------------------------------------------- |
| 0        | human chat (a human-triggered item of kind `chat`) |
| 10       | human-triggered                                    |
| 50       | agent-triggered                                    |
| 60       | automation                                         |
| 80       | scheduled                                          |

Within a class, items run by explicit position, then by creation time. A new item goes after the person's queued items, so a class is first-in first-out until someone moves an item.

### One active item per person, and chat sessions beside it

`next(person)` returns the next runnable item, or nothing while the person is paused or every queued item is held back by a policy, a failure backoff or a full lane. There are two lanes. Work items run one at a time per person: an item waits while another work item is active. Chat sessions (kind `chat`) run beside the active work item, up to `policies.chat.parallel_sessions` per person (default 2); a message beyond that waits, ahead of other queued items, for a free session. An active item is never interrupted. `markActive(itemId)` starts a run and checks all policies and the lane again. The usage policy never holds back a human, so chat is answered above `pause_automatic_at`; a pause of the person or the team still holds chat back.

### Idle pull

An agent with no work item queued or running starts its next ready ticket (`policies.pull_ready`, on by default). The office checks as soon as an event it judged created a ticket assigned to the agent, assigned one to it or moved one of its tickets into `ready` (one check at a time, so a burst of events queues one item), right after a hand-back (once the hand-back's own policies, the cleanup of blocked items and any follow-up round are done), on every tick of the scheduler's housekeeping, and when the agent connects. It picks among the tickets that are assigned to the agent and in the `ready` status: the highest tracker priority first (1 is the most urgent; a ticket without one comes after those with one), then the one that entered `ready` the longest ago. A ticket in backlog or any other status, one assigned to someone else, and one the agent already has an open item on (queued, running, waiting or blocked) or started an item on since it entered `ready` are never pulled. The pick is queued as an `assigned` item about the ticket, triggered by `automation`, with the policy's instruction as its first journal line, so it counts as automatic work: usage above `policies.usage.pause_automatic_at`, or a pause of the person or the team, stops the pull (a human's request still runs), and the loop guard counts its runs like any other item's. This is what starts the tickets an agent assigns to itself, for example the pieces of a split, because a ticket an agent assigned to itself wakes nobody.

The office raises the `agent.idle` event only when the agent has a ready ticket to start, so an idle team writes nothing every tick, and the `idle_pulls_next` policy wakes the agent with it. `policies.pull_ready: false` stops the check itself, whatever `pipeline.policies` says.

### Coalescing

Wakes for the same person and subject that come close together become one run: a batch of review comments, or a review and failing checks on the same pull request. The aggregation gives each wake its window: `pipeline.wake.coalesce_seconds` (default 60), or none for a chat message, which is answered at once, and an idle pull. The first wake's item is queued and held until its window after its event; a later wake whose event falls inside that window is folded into the item instead of queuing another, whatever its kind, adding its feedback, references and, for another kind, its instruction to the journal. The item keeps the first wake's kind. When the window closes the scheduler releases the item and the agent is offered it with all the feedback (the scheduler's tick releases it too, after a restart). A wake of the same kind and subject as an item already queued or running joins that item, after the window as well; a chat message joins only a chat session that has not started, since a running one does not see it. A hold is not a failure: it counts for neither the retry nor the loop guard, and `markActive` refuses the held item with `Held until <time>, so wakes that come close together run as one.` `0` turns coalescing off; a chat message and an idle pull are never held, and a chat message that arrives while its session is still queued joins it. The trace of each folded event names the item (`itemId`) and every event folded into it so far (`folded`), and `ost explain` prints them.

### Reordering

`move(itemId, { before } | { after } | { last })` is the explicit reorder operation behind `ost work move <item> --before|--after <item>`. Only queued items of the same person can be moved. The queue is renumbered and stored, so the order survives restarts. If the target is in a different priority class, the moved item takes the nearest class that keeps the order valid.

### Loop guard

A run of an agent- or automation-triggered item is counted when it starts. When an item already had `policies.agent_loop_guard.max_runs_per_item_per_hour` runs in the last hour, it is blocked instead of started, and the reason is returned to the caller (and written to the item's journal) so the caller can report it. `tick()` also blocks queued items that tripped the guard. Human-triggered and scheduled runs are never limited.

### Which runtime ran it

A run records the runtime adapter and the model that ran it (`runs.runtime`, `runs.model`; both stay empty for a run the agent never accepted and for runs from before the columns). The agent reports them: `accept` carries the adapter and the model the person is configured with, and `session` carries the concrete model id the runtime reports when it starts, which replaces the configured one, so an item run on an alias such as `sonnet` shows the model id that was used. The office link shows them on each of an item's `runs` and on the `current` item of a person, and usage can be grouped by them from the run records. Each person on the link also carries what they are configured with, whether or not a run is going: `runtime`, the adapter of their own `runtime` or else the team's `integrations.runtime`, and `model`, their `model` from `team.yaml`, which every person has.

### Failed runs

When an agent reports that a run failed, `fail(itemId, error)` ends the run as `failed`, counts a consecutive failure on the item, and puts it back in the queue with `not_before = now + min(base * 2^(n-1), cap)`. The defaults are 1 minute and 30 minutes (so 1, 2, 4, 8, 16, 30, 30 ...) and come from `policies.retry` (`base_minutes`, `cap_minutes`, `max_failures`). `next` skips an item whose `not_before` is still in the future, so the person's other queued items run meanwhile, and `markActive` refuses it with `backoff`. The count and `not_before` are columns of the work item, so a restart keeps them; nothing is a timer in memory. Every `tick()` clears the `not_before` that ran out and the office tells the agent there is work again.

After `policies.retry.max_failures` failures in a row (default 3) the item is blocked with the reason `failed N times: <first line of the last error>`. It goes through the same path as a loop-guard block: the reason is written to the journal and logged. It is then reported like a blocked hand-back (see [Blocked hand-backs](#blocked-hand-backs)): by the blocked agent itself, to the requester, unless the team leaves that to its PM. The office posts nothing. A successful hand-back (`done` or `waiting`) resets the count, and so does blocking, so a human who unblocks the item starts with a clean count. A stale run is not a failure; it keeps its own retry-once rule. A run that an agent shutdown cut short (`interrupted`) is not a failure either: the item goes first in the person's queue with its session and worktree, and neither the failure count nor the loop guard counts the run.

### Blocked work

An item is blocked when it failed `policies.retry.max_failures` times in a row, when the loop guard tripped, when its run went stale twice, or when its person blocked it. Nothing brings it back by itself, and there is no command for it. A trusted human's comment, review or assignment wakes the agent with a new round through the [event pipeline](#event-pipeline), with the human's words as feedback; a chat session can resume blocked work by attaching a request to it (`ost work attach`). When later work of the same person finishes the work on the ticket (and the ticket is not blocked), the office closes the earlier blocked items on it, with a journal line saying which item finished it.

### Usage policy

An injected `UsageSource` reports the 5-hour and 7-day utilization. The busiest window counts:

- at or above `policies.usage.defer_scheduled_at`, scheduled work waits;
- at or above `policies.usage.pause_automatic_at`, only human-triggered work runs.

Humans are always answered. `isPausedFor(person, item)` tells why an item cannot run. If the usage source fails, the policy is skipped rather than blocking people.

#### Where the windows come from

Only an agent's runtime sees its usage limits, so agents report them with the `usage` message. The office keeps the latest windows of each person (name, utilization, reset time) as a `usage` subject in the store; a new report replaces the old one. The scheduler reads them through a `UsageSource` that `createOffice` wires up:

- A report older than 30 minutes (`usageStaleAfterMinutes`) is unknown, like a person who never reported. Unknown usage fails open: the policy is skipped and the office logs one warning per person until fresh data arrives.
- A window whose reset time has passed counts as reset and is ignored.
- Limits apply per credential, and a credential belongs to one runtime. When several people share one subscription, list them in `policies.usage.shared` (for example `[[sam, kim]]`); a report from any member is stored for every member on the same runtime as the reporter. A person can be in one group only, and `ost validate` rejects a group whose members run on different runtimes (`policies.usage_shared_mixed_runtime`). Everyone else counts alone, against the credential of their own container.
- A person whose runtime does not provide `runtime.usage` never reports, so the policy is not applied to them; `ost validate` warns about it (`people.runtime_without_usage`).
- `ost roster` shows each person's busiest window and when it resets, as long as the report is fresh.

### Stale runs

An active item with no heartbeat for `staleAfterMinutes` (default 10) is sent back to the queue once. If the retry also goes stale, the item is blocked with a reason. A good run in between resets the allowance. `heartbeat(itemId)` marks activity; `tick()` does the sweep, and `start()` runs it on the clock. A stale item goes back to the queue and is offered again with its session, like an interrupted one.

### Pause and resume

`pause()` stops the whole team from starting new work; `pause(person)` stops one person. Running items finish. `resume` mirrors it. Pauses are stored, so they survive restarts.

## Agent connection

Agents connect out to the office over a WebSocket, so an agent needs no inbound port. The office listens on one port, path `/agent`, and speaks the [agent protocol](/reference/agent-protocol/), which is defined once in the `@outstaff/protocol` package and used by both sides.

**Authentication.** Every person has a token, which the office reads from its secrets as `OUTSTAFF_AGENT_TOKEN_<HANDLE>` (the handle in upper case, `-` as `_`). The office hashes the tokens with scrypt when it starts and compares in constant time. A person without a token cannot connect. The agent sends `hello` with its handle, the token and the protocol version; a wrong token or a different protocol version closes the connection.

**One connection per person.** A new, valid connection replaces the old one. An agent that gets replaced does not reconnect on its own, so two copies of the same agent do not fight over the connection.

**Offers.** The office takes the next queued item for a person from the scheduler and offers it with its context: the journal, the subjects and links, and the [wake context](#wake-context). Delivery is at least once. The server keeps no delivery state of its own: which items are offered and accepted is stored behind the work source, so it survives a restart. After a reconnect the office offers again what was not accepted, and `welcome` lists the accepted, unfinished items to resume. Messages about an item are idempotent by its id.

**Liveness.** The office tells the agent how often to send a heartbeat, and drops a connection that is silent for three times that long. The agent drops a connection when the office stops answering and reconnects with exponential backoff and jitter, starting from one second up to thirty.

**Boundaries.** The server depends on the scheduler only through the small `WorkSource` interface, and on question routing only through the optional `Messaging` interface. Frames are limited to 1 MiB, malformed or unknown messages get an `error` reply and never close the connection, and unexpected failures reach the agent as a generic `failed` error, with the detail only in the office log.

## Wake context

Every wake hands the agent what the office already knows about the work, so the agent does not rediscover it with several verb calls. The offer's `context.wake` carries the tickets, pull requests, documents and chat threads the item is linked to, each with its link and why it belongs:

| Woken by                                          | The bundle                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code host event (review, comment, conflict, CI) | The pull request, its ticket (status, assignee, description, recent comments), its stack, and the chat thread the work started in, if any                                                                                                    |
| A tracker or docs event                           | The ticket or document, its pull requests (state, CI and failing checks, mergeability, unresolved review threads, stack) and the chat thread the work started in                                                                             |
| A chat message                                    | The thread's messages, every ticket the message names that the work state knows, and their pull requests. A reply in a known thread links directly to the work of that thread; a chat session also gets the person's current work, as before |

**References.** The office records what each work item refers to as soon as it knows it, in the store's `work_item_refs` table: one row per item and reference (`ticket`, `pr`, `doc`, `chat_thread`, `chat_message`, `branch`, `commit`), with its link, the role (`trigger`, `subject`, `created`, `attached`, `mentioned`, `inferred`), the source (the event id, the agent's verb, the chat message, or the inference) and when it was added. The first record of a reference keeps its role and time. They are written when an item is created (its subject, the event that woke it, the chat message and thread), from the agent's verbs (`ost ticket create` in a chat session, `ost work attach`, `ost doc` links), from the work state (a pull request found for a ticket, the pull request a stack is based on), and from feedback that names a known ticket. One query on an item returns all of it, and a lookup by reference finds every item that refers to it. Links between tickets, pull requests and documents (`links`) now record when they were made.

**One builder.** The office reads a snapshot around the item: its references, two rounds along the links (a document's ticket, a ticket's pull requests, a pull request's ticket and stack), and the chat threads other work on those came from. It reads ticket descriptions and comments from the tracker and unresolved review threads from the code host with its own credentials, best effort: when a port cannot be read, the bundle goes out with what the store has. A pure builder turns the snapshot into the bundle, closest to the wake first, within the `pipeline.context` limits of `team.yaml`: the latest `comments` of each ticket, `messages` of each thread, `threads` of each pull request, at most `items` linked items, and text cut at `body_chars`. Chat history is the messages the office received in the thread (the agent's own replies are posted by the agent and are not in it).

**Untrusted text.** Titles, descriptions, comments, review threads and messages are data from the people who wrote them. The protocol marks them so, and the agent quotes them in the prompt under a line that says they are not instructions.

**Traced.** What the bundle carried is added to the trace of the event that woke the item: every linked item with its link, role, source and how many comments, threads or messages went in. `ost explain <event>` prints it under "Context handed over".

## Work state

The work state is the office's picture of the world: every live ticket and pull request, who owns it, whether CI is green, whether it merges cleanly, how many review threads are open, and which pull requests are stacked on which. It is built from intake events and from reading the ports, and it implements the read-only `WorkflowState` that the pipeline's policies are evaluated against.

**Source of truth.** The latest state of each ticket and pull request is stored as a subject (`ticket` / `pr`) and the relations as links: `pr implements ticket`, `pr authored_by person`, `pr stacked_on pr`, `ticket assigned_to person`. A `workstate/index tracks ...` link marks the records the work state keeps. On start the state is rebuilt from the store. Losing the store only costs a `rescan()`.

**Applying events.** `apply(event, meta)` is registered as an intake handler. It is idempotent: it re-reads the pull request (details, mergeability, checks, review threads) or the ticket through the ports, so applying an event twice, or out of date, converges on the same state. Reading what the ports say now, not what the event said, is what makes at-least-once delivery safe.

**Links.** A pull request belongs to the first ticket key the tracker knows among: the branch name, the title, then a closing keyword in the body (`Closes`, `Fixes` or `Resolves` and their other forms, case-insensitive, as on GitHub: `Closes ACME-12`). A repository may add patterns of its own with `repos[].ticket_link`. A key mentioned elsewhere in the body links nothing, so no policy acts on it. Keys the tracker does not know are ignored, and the work state logs which source linked the pull request. The author is matched to a person through `people[].identities.vcs`, the assignee through `identities.tracker`. A pull request whose base branch is the head branch of another open pull request is stacked on it; `stackedOn(repo, branch)` returns everything above the branch, bottom first.

**Derived events.** Two things happen without a platform event, so the work state raises them itself, as `pr.conflicted` and `pr.ci_failed` from the actor `workstate`:

- after `pr.merged`, every other open pull request in the repository is re-read waiting for the host to compute mergeability; one that now conflicts (including one that was still `unknown` before) raises `pr.conflicted`. If the host still has not decided, the next rescan catches it;
- when the checks of an open pull request turn to failure, it raises `pr.ci_failed`.

**Stacks and the end of a ticket.** `pr.merged` moves the ticket to done (`merged_closes_ticket`, as the author, or for a human's pull request as the ticket's assigned agent, else its last worker) only when the pull request targets the repository's default branch (`repos[].default_branch`) and no other pull request linked to the ticket is open. A pull request merged into another one's branch, or while another is open, leaves the ticket where it is, so the conflict on the next pull request of the stack (`pr.conflicted`) still goes to its author whatever the ticket's status (`rebase_to_author` needs only an open pull request by an agent that is not canceled). `pr.ci_failed` works the same way (`ci_failed_to_author`): an open agent pull request whose checks fail wakes its author for a `ci_failed` round, with the failing checks (names, links, summaries) as feedback, whatever the ticket's status; the work state raises it once per head commit. When the round starts, `start_marks_active` gives the ticket back to the agent and moves it to active, unless it is done or canceled.

Their ids are stable (`pr.conflicted:<repo>#<n>:<head sha>`, source `workstate`), so each is raised once per head commit. They are recorded with `store.recordEvent` before the new state is saved, then handed to the handlers registered with `onEvent` (the pipeline); a handler failure leaves the event unprocessed, and intake redelivers it. The first rescan of a pull request the work state did not know only sets a baseline and raises nothing.

**When a ticket entered its status.** Each ticket records `statusSince`, when it entered its current status: the time of the tracker event that moved or created it, else the tracker's last update of the ticket when a rescan finds the change. It stays while the status stays; a move event restarts it even when the status reads the same (the ticket left and came back between two reads), but never back in time. Ordering uses these timestamps, never ids. A ticket also keeps the tracker's `priority` when the adapter reports one (`Issue.priority`, 1 the most urgent). `readyTickets(person)` lists the ready tickets an agent could start next, for the idle pull.

**Polling.** CI results and mergeability arrive without events, so `start()` rescans open pull requests every `refreshIntervalMs` (default 60 seconds) and `rescan()` does it on demand. A rescan also finds pull requests that were merged or closed while the office was down, and the tickets assigned to the team's people. Finished tickets and closed pull requests are forgotten after 14 days.

**Queries.** Besides the `WorkflowState` methods, the last agent who worked on a ticket comes from the work item history (items whose subject is the ticket, or one of its pull requests, that have left the queue), and the requester is the latest trusted human who created the ticket, assigned it, or sent it back with a review or comment on its pull request (by event time; a code host login is mapped to the human's tracker identity through `humans:`). The requester is who a hand-back assigns the ticket to, so only someone the tracker can assign is recorded: a reviewer with no tracker identity in `humans:` (or any reviewer, without a `humans:` list) leaves the earlier requester in place. With no requester on record, the hand-back falls back to the first human in `humans:` with a tracker identity, and its trace says which of the two it chose; with no such human an act that assigns the requester is dropped, and its trace names the ticket. `currentWork(person)` returns the person's tickets and pull requests with status, CI, mergeability, unresolved threads and links, and `formatCurrentWork` renders it as a few lines for the agent's session context.

## Agent-to-agent questions

`ost ask <handle|role> "<question>"` lets an agent ask a teammate and carry on with the answer. The office routes the question, keeps it as a conversation in the store, and mirrors it to humans.

**Routing.** A handle goes to that person. A role goes to the least busy person with it, measured as queued plus active work items, with ties broken by the order in `team.yaml`. Asking your own role means a peer, so the asker is left out. A role nobody has (or a role only the asker has) is not dropped: the asker gets an error saying `no devops on this team; ask a human`. The roster is read from the live team on every question, so hires and departures need no restart.

**A question is a work item.** The office creates a `conversations` row and a child work item for the target (kind `question`, trigger `agent`, parent = the asker's current item, subject = the conversation). The item goes through the scheduler like any other, so the loop guard applies: an item that keeps cycling through ask and answer is blocked by `agent_loop_guard`. The first journal entry of the child item says who asks (handle and role), the question and its id, the asker's work item and ticket, and how to answer (`ost answer <question-id> "<answer>"`, the `question_answer` tool). A question can only be asked from inside a work item, because the answer needs somewhere to go.

**Depth limit.** Questions asked while answering a question nest. The depth is the parent conversation's depth plus one, and a question beyond the limit (default 3) is refused with a message telling the agent to decide or ask a human.

**Answering.** Only the target of a question can answer it, once. The answer is stored, written to the journal of the asker's original item, and the item is resumed: a waiting item goes back to the queue and continues its session with the answer in its journal, a finished item gets a follow-up item that takes over its session, and a queued or blocked item keeps its place and sees the answer on its next run. If the asker is still running when the answer comes, the answer is stored as not yet delivered; when the asker hands back as waiting (or done), the office queues the item again (or starts the follow-up) with the answers in its journal and marks them delivered, so an answer cannot be missed by a race. The protocol server calls `messaging.onHandBack` after every hand-back for this.

**Mirroring.** Every question and answer is mirrored to humans. If the chat adapter exists and `office.channel` is set, the office posts to that channel. Otherwise the asker's agent comments on the ticket of the asker's item, when it has one, as itself: the office sends it a comment [act](#acts), which an offline agent makes when it connects. The asker's journal always records where the text went, so nothing is invisible. A failing channel, or an act that cannot be queued, falls through to the next option and never fails the question.

**Roster.** `ost team` (`ost roster`) shows the people with role title, busy or idle (or paused), what they work on, and the trusted humans. Titles and summaries come from the catalog when the office has it; otherwise the role id is shown.

## Chat requests and report-back

A trusted human asks an agent for something in chat; the agent's chat relay (see [The agent](/architecture/agent/)) sends the message to the office with `chat_message`. The office records it as a `chat.message` event, adds it to the thread's log and answers whether it had it already (`repeated`); the agent posts nothing more. The [event pipeline](#event-pipeline) decides on it like any event: `chat_to_addressed` wakes the agent it was written to with a chat session (kind `chat`, subject the conversation), with the thread's origin (channel, thread, requester), the message as feedback of kind `chat`, and the message and the tickets it names as references, so the [wake context](#wake-context) and the filing verbs work. A chat session runs beside the active work item, so a question is answered while a review round runs; at most `policies.chat.parallel_sessions` run at once. The state lives in the store as subjects (`chat_origin` per item, `chat_thread` per thread, `chat_log` with the latest messages of each thread), so it survives a restart. A message the platform delivers twice is recorded once.

**The thread's work.** A message in the thread of work filed or attached from chat starts a session that is told which item it is about (running or finished) and gets that item's tickets and pull requests as references. While that work runs, the thread stays with it, so its result is posted there; once it is finished, the thread moves to the new session. A session in the thread of an earlier chat session goes on with that session's conversation. A message joins a chat session of its conversation only while that session has not started.

The rest is the backend of the chat session's verbs (`work_link`, `work_check`, `work_queue`, `work_attach`), the reports (`chat_report`, the queued reports and `report_posted`) and `current_work`:

- **A question or a discussion:** the session answers in its last message, which is posted in the thread. No ticket, no work item, no queue.
- **Work:** the session files it. With a tracker it runs `ost ticket create` (`work_link`); without one it runs `ost work queue` (`work_queue`). The office then creates a work item in the same thread (kind `assigned` with the ticket as its subject, or kind `request`), with the thread's origin, and moves the thread to it; the session's origin records `filed` (the latest item) and `requests` (the requests filed so far). One message may hold several requests and each is filed once: before it creates a ticket the session sends `work_check`, which refuses a request the message already filed, so a refused filing leaves nothing in the tracker; the same request filed again is refused, and each request gets its own acknowledgement. A ticket an agent creates and assigns to itself wakes nobody, so the tracker echoing it back produces no second item. The session has nothing to report; the work item reports its own result in the thread.
  - **Idle** (no other work item active or queued): the new item goes first and starts at once.
  - **Busy:** the new item waits last and is marked as awaiting a placement. `work_link_result` carries the person's other open work items in the order they run, so the agent posts the placement question with the grouped list. The requester's answer is a message like any other: the chat session it wakes moves the item with `ost work move` (`work_place`).

- **Work that already exists:** a request about a ticket or pull request the person already has is attached to it, not filed as new work (`work_attach`, `ost work attach <ticket|pr>`). The office takes only the person's own work (a ticket assigned to them or that they last worked on, a pull request they authored or whose ticket is theirs). The state of the work decides:
  - **Draft pull request, active ticket, or a ticket with no pull request yet:** the request joins the item already working on it (active, queued, waiting or blocked, which is retried), which keeps its place; if no item is, a `review_feedback` round on the pull request (or an `assigned` round on the ticket) is queued in the human class. Either way the human's message is stored as feedback of kind `chat` (a running item gets it in a follow-up round), the thread's origin is put on the item and the thread moves to it. Nothing is asked about its place. When the round starts, `start_marks_active` assigns the ticket to the agent again and moves it to active.
  - **Pull request in review** (open and ready, or approved; or a ticket in `review` without a pull request): refused unless the session passes `confirmed`, which it does after the requester said in the thread that the request belongs there. Until then nothing is queued and no ticket is created. If the requester wants a follow-up instead, the session files a new ticket.
  - **Merged or closed pull request, done ticket without an open pull request, canceled ticket:** always refused. Finished work is never reopened; the request is a follow-up.
  - **Open pull request whose ticket is done** (a merge into another pull request's branch closed it early): accepted like any open pull request, in review or not. The request attaches to that pull request. No ticket is created.

**Report back.** `chat_report` is a claim: the office answers whether the agent should post, once for each ending of an item (`result` for a finished item, `blocked`, `failed` once per item), together with the requester and the links of the item: its ticket, if the agent made one, and the pull requests that implement it. The first reply is a claim of its own (`ack`), made when the session files its work. A retried hand-back or a restart cannot post twice. An item the scheduler blocks on its own (loop guard, stale twice, too many failures) is reported in the same way as a blocked hand-back and the thread of a chat item always hears from its agent; the office posts nothing about it. Follow-ups are items of their own without a chat origin, so a review round or a question reports nothing until the requester's item finishes.

**The office never posts to people.** Every message a human reads in chat comes from an agent, as itself. The office only decides and records. A chat item's result goes to the thread it came from, and a blocked item is reported by the agent only when the team leaves that to the agent (see [Blocked hand-backs](#blocked-hand-backs)); the agent posts it right after the hand-back, done by the runner and not by the model.

**If the agent is offline.** The office records the report the agent owes (the hand-back summary or block reason, links and time) in the store, per person, when the item ends or is blocked. If the agent claims it with `chat_report`, nothing is left in the queue. If not, because the agent died or was offline, or because the scheduler blocked the item and there was no hand-back, the report waits. The office sends the queue to the agent in the `welcome` of each connection and pushes new reports with a `reports` message while it is connected. Each report has an id; the agent posts it as itself (in the item's chat threads, or in a direct message with the requester for a blocked item that did not come from chat), skips an id it posted already, and confirms with `report_posted`. Only then does the office drop it, so a crash while posting sends it again. The office posts nothing, and a late `chat_report` for a confirmed ending is answered with `post: false`. The queue is in the store, so a restart of the office keeps it. An agent without a chat port posts nothing.

### Blocked hand-backs

When an agent hands an item back as `blocked` (or as `done` on a ticket it left blocked), where the ticket goes depends on whether the team has a PM (a person whose role is `pm`) other than the blocked agent:

- **With a PM:** the policy `hand_back_blocked_to_pm`, acting for the blocked agent, moves the ticket to `blocked` and assigns it to the PM, then wakes the PM with an `unblock` item. The blocked agent's process makes that assignment, so the tracker reports it as the agent's; it is the act's echo and wakes no one (see [Acts](#acts)), so the PM runs one round for the hand-back. The wake carries the blocked agent, the ticket (with its latest comments) and what the agent handed back. The PM tries everything before a human is involved: it answers from what it knows, finds the information, or asks the right teammate with `ost ask`. When the ticket is unblocked, the PM comments the answer and assigns the ticket back to the blocked agent; that assignment wakes the agent (`assigned_to_assignee`), and the PM's comment reaches it in the wake's context. Only when the PM cannot unblock it does it assign the ticket to the requester, with a comment that says exactly what is needed. The PM's `unblock` round changes no ticket status, so it is handed back as done.
- **Without one, or when the blocked agent is the PM:** the policy `hand_back_blocked` moves the ticket to `blocked` and assigns the requester, acting for the agent, with the agent's note.

Who tells the requester in chat follows `policies.hand_back.blocked_notify`, for a blocked hand-back and for an item the scheduler blocked alike:

- `agent`, and always for a team without a PM or when the blocked agent is the PM: the blocked agent tells the requester itself, right after the hand-back: in the thread of a chat item, otherwise in a direct message with the requester of the ticket (the first human when the ticket has none), with the ticket linked and what is needed. The direct message is opened by the agent's own chat identity, from `humans[].identities.chat`.
- `pm` (the default when the team has a PM role): the thread of a chat item still gets its agent's reply; for work with no chat origin the blocked agent sends nothing and leaves it to the PM, who gives the ticket to the requester, saying what is needed, only when it cannot unblock it.

## Event pipeline

The pipeline (`packages/office/src/pipeline`, [decision 0016](/decisions/0016-event-pipeline/), the only way the office decides since [decision 0018](/decisions/0018-pipeline-only/)) judges each event with the team's policies: the [built-in ones](/reference/pipeline-policies/), each a module in `pipeline/policies/`, then the team's custom ones (`policies.custom`, see [Writing a policy](/guides/writing-a-policy/)), with `pipeline.policies` applied. A `pipeline.policies` entry it cannot use (an unknown id, an instruction with an unknown variable) or a custom policy whose id is taken is logged as a warning when the office starts, and the default stays; a custom policy that cannot be loaded stops the office from starting.

**Bus and aggregation.** The bus hands each event to every policy that listens to its type. Each policy is pure: it reads a read-only context (the event, the work state, the team, its settings) and returns proposals: `wake`, `act`, `drop` or `suppress`, each with a reason. A policy that throws is contained: its run carries an `error` proposal and the others decide as usual. The aggregation layer (`pipeline/aggregate/`) then makes the decisions: it enforces the invariants (never act as the office or for anyone not an agent on the team, never wake an agent for its own action, an act's echo wakes no one (see below), the loop guard: no event a bot other than the office's own checks caused wakes anyone, an act is bookkeeping only and one per policy), applies suppressions (a suppression beats a wake), settles acts on the same ticket field by priority, then order, and merges wakes of one person, subject and kind into one. It also sets each wake's coalescing window: none for a chat message or an idle pull.

**What it judges.** Every event intake delivers, after the work state applied it; the work state's own `pr.conflicted` and `pr.ci_failed`; `chat.message`; `agent.started`, which the office raises when an agent accepts an item on a ticket (or on a pull request with a ticket); `agent.handed_back`, which the office raises when an agent hands an item back; and `agent.idle`, which the [idle pull](#idle-pull) raises. Two kinds are dropped before any policy is evaluated: an event from an untrusted human, and an inline comment of a review that is still pending. An event no policy matches is dropped with `no policy matched`; one whose policies matched but proposed nothing, with `no policy proposed anything`.

**The trace.** Every judged event gets one trace in the store, under the event's `<source>:<externalId>`: each policy that listens to it, whether it matched and why, the first condition that failed, what it proposed, what the aggregation made of each proposal (kept, merged, suppressed, rejected, dropped, or an error) and why, the decisions, the work item each wake queued or was folded into, the result of each act, and what the [wake context](#wake-context) carried. `ost explain` prints a trace, and the [office link](#office-link) serves it.

**What it does.**

- A **wake** queues a work item for the person through the scheduler, with the trigger of the event's actor (an idle pull is `automation`), the event's feedback, its references, and the instruction as the item's first journal line, written by `office`. Wakes for the same person and subject [coalesce](#coalescing). A chat wake queues a chat session with the thread's origin.
- An **act** is made by the agent it names, as itself ([decision 0019](/decisions/0019-agents-make-their-acts/)): the changes, then the policy's note, if any, as a comment on the ticket. See [Acts](#acts). Each act is handed over once per event and policy, so a redelivered event does not repeat it.
- Errors propagate, so intake delivers the event again; the trace, the queue and the acts are idempotent per event.

### Acts

The office sends an act to the agent it is for as an `act` message, `{id, ops}`, with the id `<event id>:<policy>`. The agent's process (`ost-agent`, not a model run) makes the changes in order with its own tracker and knowledge ports, stops at the first that fails, and answers `act_result` with one line per change made and the error. Acts are kept per person in the store until the agent answers: one for an agent that is not connected waits, and the `welcome` of its next connection carries every act it has not answered. The agent answers an id it already made without making it again, so a lost answer costs nothing; an agent that crashes between the changes and its answer makes them again.

**Echoes of acts** ([0022](/decisions/0022-act-echoes-wake-no-one/)). The tracker reports an act's changes as the acting agent's: a blocked hand-back's assignment to the PM comes back as "assigned to pia by sam", which would wake the PM a second time. When the desk sends an act it records each change on a ticket (a move, an assignment, a comment), before the agent has it. The first tracker event of that kind on the ticket by the acting agent that shows what the change leaves (the assignee or status in the work state after the event, the comment's body) is the change's echo: the pipeline marks it with the act's id (`echo` in its data), and the invariant rejects every wake proposed on it. Each change is recognised once, the same event delivered again included, and is expected for a day. An agent's own change, such as the PM assigning the ticket back, is no echo and wakes as usual.

On the answer the office reads the tickets the act moved, assigned or re-parented again (`refreshTicket`), so the next decision sees the change before the tracker's feed reports it. The trace of the event records each act: `queued`, `delivered` once it was sent, then `done` or `failed` with the agent's lines, the error, and when each step happened.

**Outside the decisions.** After a hand-back the office does its own bookkeeping, which decides nothing and changes nothing outside the office: feedback that reached an item after its offer gets one follow-up round in the same threads (`policies.feedback.follow_up_round`), and the person's earlier blocked items on a ticket the finished work settled are closed. Starting the work is the pipeline's: when the agent accepts the next round, `agent.started` has `start_marks_active` give it the ticket and move it to active.

## Office identities

The office acts under its own name on every system it uses, named `<team>-outstaff-office`:

- **Code host:** a read-only GitHub App (`GH_OFFICE_APP_*`). All reads go through it, and agents hold it too to clone read-granted repositories.
- **Tracker:** its own member account (`ITSAPLAN_API_KEY` in the office scope), for reading only: tickets, members and the activity feed. The office writes nothing to the tracker or the knowledge base; the pipeline's acts and the mirror of questions on a ticket are made by agents, as themselves.
- **Chat:** none, unless the team sets `office.channel`. The office posts to no person; the only thing it ever writes to chat is the mirror of agent-to-agent questions and answers in that team channel, through its own Slack app (`SLACK_OFFICE_BOT_TOKEN`), which has no app-level token because the office never listens to chat. Without `office.channel` the office has no chat port and needs no chat app; with it, `createOffice` creates the port in office scope and stops at startup with an error naming `SLACK_OFFICE_BOT_TOKEN` when the token is missing.

**Why per-team apps.** Outstaff hosts no shared keys. A shared app would hold every team's installation behind one credential, and revoking or auditing one team would touch all. With one app per team, the team owns the credential, its permissions and its audit trail, and can remove it at will.

**Why read-only is safe.** The office never writes code: it reads pull requests, reviews and CI to keep work state, and agents write through their own Apps. A leaked office key can read the repositories it is installed on, but cannot push, merge or comment, and the office's chat token cannot join channels it was not invited to or act as a person. Give the office App only the permissions in the setup guide, and install it on the repositories in `repos`.

`ost validate` also checks the identities written in team.yaml: each adapter validates the ones it owns (a Slack member id, a GitHub login for humans and an App bot login `<slug>[bot]` for agents, a non-blank tracker identity) and reports located warnings. See the [validation codes](/reference/validation-codes/).

## Running the office

`createOffice` assembles the parts above into one process, and `outstaff-office` (the `bin` of `@outstaff/office`) starts it from the environment. The office image runs that command.

**Wiring.** The office creates its ports from `integrations` in team.yaml through the adapter registry, with the office-scope secrets. Version control is required; the tracker and chat are used when configured. An adapter that is configured but not installed in the image stops the start with a message naming it. Events then flow in one fixed order, as in [How an event flows](#how-an-event-flows): intake records an event, the work state applies it, then the pipeline judges it. The work state's own `pr.conflicted` and `pr.ci_failed` skip intake and are judged the same way. Every item the pipeline, the messaging or an agent queues goes through the scheduler, which tells the protocol server so the agent is offered the work at once.

**Offers.** What was offered and what the agent accepted is stored (as `offer` subjects), so a restart offers again only what was not accepted. The offer carries the item's journal, the ticket and pull requests it concerns with their links, and `ost work` shows the agent's open items. When an agent hands an item back as `done`, the office raises `agent.handed_back` for the ticket, so the policy `hand_back_done` moves it to review and assigns the requester. A `done` hand-back on a ticket that is `blocked` is treated as `blocked`: the ticket stays blocked and is handled as a [blocked hand-back](#blocked-hand-backs). When an agent accepts an item on a ticket, or on a pull request with a ticket, the office raises `agent.started` before the agent hears back, so `start_marks_active` assigns the ticket to the agent and moves it to active (unless it is done or canceled) before the round looks at it; the tickets an act changes are read again at once, so the next decision sees them as the act left them. The agent runner also hands back as `blocked` an item that ends with its ticket still blocked in the tracker, when the agent moved nothing and asked nothing (except a PM's `unblock` round, whose ticket stays blocked for the agent it goes back to). When an item of a person finishes the work on a ticket that is no longer blocked, that person's earlier blocked items on the ticket are closed (canceled), so none is left behind. A repeated hand-back repeats nothing. The runtime session an agent reports for an item is stored with it and goes on the next offer. An agent that restarts gives back the items it had accepted with `decline`: they stay as they are (same run, journal and session, no new attempt) and are offered again. Agents report their usage windows with `usage`; see the usage policy above.

**Start and stop.** `start()` opens the agent connection, then the work state (with one rescan) and intake, which redelivers any events that were recorded but not handled. `stop()` stops intake, lets running handlers finish, closes connections and the store. `SIGTERM` and `SIGINT` do this.

### Environment

| Variable                                         | Meaning                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OUTSTAFF_TEAM_FILE`                             | Path to team.yaml (or the folder holding it). Alternatively `OUTSTAFF_TEAM_REPO` and `OUTSTAFF_TEAM_REF`. Only the office reads it; it sends the validated team config to each agent in the `welcome`. |
| `OUTSTAFF_STORE_URL`                             | `postgres://user:pass@host/db`, `sqlite:///var/lib/outstaff/office.db` (the default) or `sqlite::memory:` for tests.                                                                                   |
| `OUTSTAFF_AGENT_PORT`                            | Port agents connect to, path `/agent`. Default 8080.                                                                                                                                                   |
| `OUTSTAFF_WEBHOOK_PORT`                          | Port of the webhook receiver when `office.events` is `webhook`. Default 8082.                                                                                                                          |
| `OUTSTAFF_HEALTH_PORT`                           | Port of the health endpoints. Default 8081.                                                                                                                                                            |
| `OUTSTAFF_AGENT_TOKEN_<HANDLE>`                  | One token per person, as a secret.                                                                                                                                                                     |
| `OUTSTAFF_SECRETS_DIR`                           | Directory of secret files, default `/run/secrets/outstaff`; the environment is the fallback.                                                                                                           |
| Adapter secrets (for example `GH_OFFICE_APP_ID`) | Whatever the configured adapters declare for the office scope.                                                                                                                                         |

The SQLite file's folder is created when missing; mount a volume there. Use Postgres to run the office on a platform without persistent disks. Migrations run on start.

### Health

- `GET /healthz` is liveness: 200 while the office is starting or running and its parts (store, agent connection, work state, intake, scheduler) are up, 503 once something fails or it is stopping.
- `GET /readyz` is readiness: 200 only while the office is running.

Both answer with JSON: `{ "ok": true, "state": "running", "components": { "store": { "ok": true, "detail": "sqlite" }, … } }`. The same data is available in code as `office.health()`.

The `doctor` component sums up the doctor checks and is always `ok`. The same port answers `GET /doctor` with the stored doctor checks and `POST /doctor` by running the office's checks first, for `ost doctor --via-office`.

### Doctor checks

The office runs the [doctor checks](/guides/doctor/#the-office-runs-the-checks-itself) of its own scope (its secrets, including each person's agent token, and each configured adapter's live checks) once it is running, every day at `office.doctor.daily_at` in the container's time zone, and on demand. A run in progress is joined, not repeated. Each agent runs its own checks (tools installed, services and devices reachable, home volume space) when it starts and sends them with `doctor_report`. The store keeps one row per scope and check with its status, message, fix, first seen and last seen; a run replaces its scope's rows, keeping the first-seen time of a check whose status did not change. Results go to the logs, the `doctor` health component, `/doctor` on the health port and the office link; the office never posts them.

### Office link

With `link.url` in team.yaml and the secret `OUTSTAFF_LINK_TOKEN`, the office connects out over a WebSocket to a monitoring or management service, a dashboard for example. The service keeps no office data: it asks the office for people, events, one event's trace, work items, and its health with the doctor checks, and the office tells it when people, traces or items change. An office that is offline shows nothing. See the [office link protocol](/reference/office-link/).

### Logs

One JSON object per line on standard output, with `time`, `level` and `message`. `OUTSTAFF_LOG_LEVEL` sets the lowest level written (`debug`, `info`, `warn` or `error`; default `info`). See [What the logs say](#what-the-logs-say) for which lines appear at which level.
