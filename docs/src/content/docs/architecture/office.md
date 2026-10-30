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
                   pr.ci_failed ---------+---> judge the event <--- agent.handed_back, agent.idle
                                                     |               (raised by the office)
                     off:    the engine's workflow rules decide; nothing is traced
                     shadow: the event pipeline judges and traces first, then the rules decide
                     live:   the event pipeline decides, and traces why
                                                     |
                   +---------------------------------+------------------------------+
                   v                                 v                              v
                 wake                               act                           drop
       the scheduler queues a work      the office changes the tracker        the reason is on
       item (coalesced, live)           for the agent, with a note            the trace
                   |
                   v
       the agent connection offers the item with its journal and wake context
```

[Intake](#intake) records each event once and hands it on in order; the [work state](#work-state) applies it and raises the events no platform sends; the [engine](#engine) (pipeline off or shadow) or the [event pipeline](#event-pipeline) (live) decides; the [scheduler](#scheduler) runs the work; the [agent connection](#agent-connection) offers it with its [wake context](#wake-context). [What outstaff does on its own](/concepts/automation/) explains the decisions, the default policies and the modes from a team's point of view.

## Intake

Intake turns activity in your repositories, tracker, knowledge base and chat into deduplicated, normalized events for the work state and whichever of the event pipeline and the engine decides.

### Modes

`office.events` in the team config selects the mode.

- **poll** (default). Every `office.poll_interval_seconds` the office asks the VCS adapter for events across all team repos and, if a tracker is configured, the tracker adapter. Each source polls on its own timer.
- **webhook**. The office listens for `POST /webhooks/vcs` and `POST /webhooks/tracker`. The adapter verifies the signature and parses the body; intake only does the HTTP. A bad signature gets `401`, a malformed body `400`, a source without adapter support `404`, an oversized body `413`. Adapters opt in by implementing the optional `parseWebhook(headers, body)` method of their port.

### What the logs say

Intake, the engine and the pipeline log at info level by default, so "the agent did not react" can be answered from the logs; with the pipeline in shadow or live mode, `ost explain <event-id>` answers it in full. Feeds are re-read with a 5-minute overlap, so the same events come back on every poll; those repeats are kept out of the info level.

- `intake: recorded <source> <type> on <repo#n or ticket> by <actor> (trusted|untrusted)` for every event kept. Info.
- `intake: dropped <source> <type> on <subject>: <reason>` for every event read but not kept. The reason is that the adapter does not map the event type, that the office does not map it (for example `pr.synchronize`), or that it is a duplicate.
  - An unmapped event (either reason) is logged at info the first time per event id, then at debug. The office remembers ids in memory for the overlap window, so after a restart a repeat can show at info once more.
  - A duplicate of an event already recorded is always debug.
- `engine: rule <id> matched <type> on <subject>: <effects>` for each rule that matched, then `engine: scheduled review_feedback for sam on acme/app#8` (or moved, assigned, commented) for each effect that was applied, and `engine: no rule matched <type> on <subject>` when none did. Feedback for a pull request whose `review_feedback` item is already queued or running is not an error: it is attached to that item and logged as `engine: attached to work item <id> (review_feedback, queued)` (or `running`). Other effects that were skipped or failed are warnings.
- `engine: queued follow-up work item <id> for sam: 1 new feedback after <id> was offered` after a hand-back, when feedback was attached to the item after the agent was offered it.
- Live, `pipeline: queued work item <id> for sam (review_feedback)` for each wake, or `pipeline: folded the wake into work item <id> for sam (review_feedback)` when it joined an item in its [coalescing](#coalescing) window. The pipeline's other decisions are on the trace, not in the log. A `pipeline.policies` entry the office cannot use is a warning at start (`pipeline: pipeline.policies.<id>: ...`).
- `idle pull: queued work item <id> for sam on ACME-12` when an idle agent is given its next ready ticket with the pipeline off or in shadow mode.
- A failed poll is an error. When a polled source has had no successful poll for `office.poll_warn_after_minutes` (default 10), each further failure also logs a warning with the minutes.

| Level | Lines                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| debug | duplicates of recorded events; unmapped events after their first sighting                                                                  |
| info  | recorded events; first sighting of an unmapped event; rule matches, no-match and applied effects; pipeline wakes; idle pulls; baseline set |
| warn  | effects not applied; failing event handlers (before they are given up on); polls with no success past `office.poll_warn_after_minutes`     |
| error | failed polls; failed event delivery; events given up on                                                                                    |

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

A chat message is not read from a source: the agent the message was written to passes it on (see [Chat requests and report-back](#chat-requests-and-report-back)). With `office.pipeline` in shadow or live mode, intake records it with `receive` as `chat.message`, source `chat`, id `<agent>:<channel>:<message id>`, and delivers it with the other events, in order and at least once. Its subject is the conversation: the thread of a reply or of a top-level message in a channel, and the whole direct message for its top-level messages, so quick follow-ups are one conversation. The actor is the human who wrote it (the agent passes on only trusted humans' messages), and `data` has the text (`body`), the agent it was written to (`addressed`) and the message itself. The work state and the engine never see it; only the [event pipeline](#event-pipeline) judges it. With the pipeline off it is not recorded: the chat desk routes it.

### Who acted, and whether to trust them

Each event has an actor kind.

- **agent**: the VCS login matches a person's `identities.vcs` exactly (ignoring case), or the tracker member's id or username equals the person's `identities.tracker`. Nothing else makes an actor an agent, however its name looks, so an outside account cannot pass as one of your agents by naming itself after one. A person with a write grant but no `identities.vcs` triggers the `people.missing_vcs_identity` warning: their pull requests and comments are treated as an unknown human's.
- **automation**: any other login ending in `[bot]`, or a tracker member of kind `agent` that is not a team person.
- **human**: everyone else. A human is trusted when they have `write` or `admin` permission on the repository (looked up with `vcs.permission` and cached in the store for 10 minutes), or are listed in `humans:` when that list exists. Tracker members of kind `human` are trusted.

Events from untrusted humans are still recorded and delivered, but carry `data.untrusted: true` (and `meta.trusted === false` in the handler) so neither the engine nor the pipeline ever treats them as instructions: the pipeline drops them with that reason on the trace.

### Using it

```ts
const intake = createIntake({ store, ports: { vcs, tracker }, team, clock, logger });
intake.onEvent((event, meta) => engine.handle(event, meta));
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

An agent with no work item queued or running starts its next ready ticket (`policies.pull_ready`, on by default). The office checks as soon as an event it judged created a ticket assigned to the agent, assigned one to it or moved one of its tickets into `ready` (one check at a time, so a burst of events queues one item), right after a hand-back (once the hand-back's own rules, the cleanup of blocked items and any follow-up round are done), on every tick of the scheduler's housekeeping, and when the agent connects. It picks among the tickets that are assigned to the agent and in the `ready` status: the highest tracker priority first (1 is the most urgent; a ticket without one comes after those with one), then the one that entered `ready` the longest ago. A ticket in backlog or any other status, one assigned to someone else, and one the agent already has an open item on (queued, running, waiting or blocked) or started an item on since it entered `ready` are never pulled. The pick is queued as an `assigned` item about the ticket, triggered by `automation`, with a journal line saying why, so it counts as automatic work: usage above `policies.usage.pause_automatic_at`, or a pause of the person or the team, stops the pull (a human's request still runs), and the loop guard counts its runs like any other item's. This is what starts the tickets an agent assigns to itself, for example the pieces of a split, because an event an agent caused itself schedules nothing for it.

The office raises the `agent.idle` event only when the agent has a ready ticket to start, so an idle team writes nothing every tick. With `office.pipeline` off the scheduler queues the pick itself; in shadow mode the pipeline traces its decision first and the scheduler still queues it; live, the `idle_pulls_next` policy wakes the agent with it instead. `policies.pull_ready: false` stops the check itself, whatever `pipeline.policies` says.

### Coalescing

With `office.pipeline: live`, wakes for the same person and subject that come close together become one run: a batch of review comments, a review and failing checks on the same pull request, or quick follow-up messages in chat. The first wake's item is queued and held until `pipeline.wake.coalesce_seconds` (default 60) after its event; a later wake whose event falls inside that window is folded into the item instead of queuing another, whatever its kind, adding its feedback, references and, for another kind, its instruction to the journal. The item keeps the first wake's kind. When the window closes the scheduler releases the item and the agent is offered it with all the feedback (the scheduler's tick releases it too, after a restart). A wake of the same kind and subject as an item already queued or running joins that item, as before, after the window as well. A hold is not a failure: it counts for neither the retry nor the loop guard, and `markActive` refuses the held item with `Held until <time>, so wakes that come close together run as one.` `0` turns coalescing off; an idle pull is never held. The trace of each folded event names the item (`itemId`) and every event folded into it so far (`folded`), and `ost explain` prints them. With the pipeline off or in shadow mode the engine schedules, and coalesces nothing.

### Reordering

`move(itemId, { before } | { after } | { last })` is the explicit reorder operation behind `ost work move <item> --before|--after <item>`. Only queued items of the same person can be moved. The queue is renumbered and stored, so the order survives restarts. If the target is in a different priority class, the moved item takes the nearest class that keeps the order valid.

### Loop guard

A run of an agent- or automation-triggered item is counted when it starts. When an item already had `policies.agent_loop_guard.max_runs_per_item_per_hour` runs in the last hour, it is blocked instead of started, and the reason is returned to the caller (and written to the item's journal) so the workflow engine can comment. `tick()` also blocks queued items that tripped the guard. Human-triggered and scheduled runs are never limited.

### Which runtime ran it

A run records the runtime adapter and the model that ran it (`runs.runtime`, `runs.model`; both stay empty for a run the agent never accepted and for runs from before the columns). The agent reports them: `accept` carries the adapter and the model the person is configured with, and `session` carries the concrete model id the runtime reports when it starts, which replaces the configured one, so an item run on an alias such as `sonnet` shows the model id that was used. The office link shows them on each of an item's `runs` and on the `current` item of a person, and usage can be grouped by them from the run records. Each person on the link also carries what they are configured with, whether or not a run is going: `runtime`, the adapter of their own `runtime` or else the team's `integrations.runtime`, and `model`, their `model` from `team.yaml`, which every person has.

### Failed runs

When an agent reports that a run failed, `fail(itemId, error)` ends the run as `failed`, counts a consecutive failure on the item, and puts it back in the queue with `not_before = now + min(base * 2^(n-1), cap)`. The defaults are 1 minute and 30 minutes (so 1, 2, 4, 8, 16, 30, 30 ...) and come from `policies.retry` (`base_minutes`, `cap_minutes`, `max_failures`). `next` skips an item whose `not_before` is still in the future, so the person's other queued items run meanwhile, and `markActive` refuses it with `backoff`. The count and `not_before` are columns of the work item, so a restart keeps them; nothing is a timer in memory. Every `tick()` clears the `not_before` that ran out and the office tells the agent there is work again.

After `policies.retry.max_failures` failures in a row (default 3) the item is blocked with the reason `failed N times: <first line of the last error>`. It goes through the same path as a loop-guard block: the reason is written to the journal and logged. It is then routed like a blocked hand-back (see [Blocked hand-backs](#blocked-hand-backs)): an `unblock` round for the PM when the team routes blocked work there, and a report the blocked agent posts to the requester itself. The office posts nothing. A successful hand-back (`done` or `waiting`) resets the count, and so does blocking, so a human who unblocks the item starts with a clean count. A stale run is not a failure; it keeps its own retry-once rule. A run that an agent shutdown cut short (`interrupted`) is not a failure either: the item goes first in the person's queue with its session and worktree, and neither the failure count nor the loop guard counts the run.

### Blocked work

An item is blocked when it failed `policies.retry.max_failures` times in a row, when the loop guard tripped, when its run went stale twice, or when its person blocked it. Nothing brings it back by itself, and there is no command for it: a trusted human retries it through the tools they already use.

| Signal       | What brings the item back                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Ticket       | A human moves the ticket to `ready` or `active`, or assigns it to the item's person.             |
| Pull request | A human reviews or comments on the pull request the item is about (or whose ticket it is about). |
| Chat         | A human replies in the thread the item is linked to, whatever kind of item it is.                |

The item is queued again with no failures, no backoff and a fresh loop-guard count. Its session and journal stay, so the agent continues where it was. The journal gets a line saying who asked and how; the office comments on the ticket, or in the chat thread, with `Retrying <subject> on request`, and logs `retried <item> for <human> on <subject> (signal: ...)`. Pull requests have no comment port yet, so a pull request signal is noted on the ticket of the pull request, when it has one.

Only trusted humans retry: an agent, a bot or a human without write access never does. Review feedback and the retry do not run side by side: when a pull request signal retries a blocked item, the review feedback rule queues no second item for that person, and the comment text is added to the retried item's journal.

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

**Traced.** When the event that woke the item has a trace (`office.pipeline: shadow` or `live`), what the bundle carried is added to it: every linked item with its link, role, source and how many comments, threads or messages went in. `ost explain <event>` prints it under "Context handed over".

## Work state

The work state is the office's picture of the world: every live ticket and pull request, who owns it, whether CI is green, whether it merges cleanly, how many review threads are open, and which pull requests are stacked on which. It is built from intake events and from reading the ports, and it implements the read-only `WorkflowState` that the engine's rules and the pipeline's policies are evaluated against.

**Source of truth.** The latest state of each ticket and pull request is stored as a subject (`ticket` / `pr`) and the relations as links: `pr implements ticket`, `pr authored_by person`, `pr stacked_on pr`, `ticket assigned_to person`. A `workstate/index tracks ...` link marks the records the work state keeps. On start the state is rebuilt from the store. Losing the store only costs a `rescan()`.

**Applying events.** `apply(event, meta)` is registered as an intake handler. It is idempotent: it re-reads the pull request (details, mergeability, checks, review threads) or the ticket through the ports, so applying an event twice, or out of date, converges on the same state. Reading what the ports say now, not what the event said, is what makes at-least-once delivery safe.

**Links.** A pull request belongs to the first ticket key the tracker knows among: the branch name, the title, then a closing keyword in the body (`Closes`, `Fixes` or `Resolves` and their other forms, case-insensitive, as on GitHub: `Closes ACME-12`). A repository may add patterns of its own with `repos[].ticket_link`. A key mentioned elsewhere in the body links nothing, so no rule acts on it. Keys the tracker does not know are ignored, and the work state logs which source linked the pull request. The author is matched to a person through `people[].identities.vcs`, the assignee through `identities.tracker`. A pull request whose base branch is the head branch of another open pull request is stacked on it; `stackedOn(repo, branch)` returns everything above the branch, bottom first.

**Derived events.** Two things happen without a platform event, so the work state raises them itself, as `pr.conflicted` and `pr.ci_failed` from the actor `workstate`:

- after `pr.merged`, every other open pull request in the repository is re-read waiting for the host to compute mergeability; one that now conflicts (including one that was still `unknown` before) raises `pr.conflicted`. If the host still has not decided, the next rescan catches it;
- when the checks of an open pull request turn to failure, it raises `pr.ci_failed`.

**Stacks and the end of a ticket.** The rule ids below are the engine's; live, the policies `merged_closes_ticket`, `rebase_to_author` and `ci_failed_to_author` decide the same. `pr.merged` moves the ticket to done (`pr-merged-done`) only when the pull request targets the repository's default branch (`repos[].default_branch`) and no other pull request linked to the ticket is open. A pull request merged into another one's branch, or while another is open, leaves the ticket where it is, so the conflict on the next pull request of the stack (`pr.conflicted`) still goes to its author whatever the ticket's status (`conflict-back-to-author` needs only an open pull request by an agent), and the ticket goes back to active while that work runs. `pr.ci_failed` works the same way (`ci-failed-back-to-author`): an open agent pull request whose checks fail schedules a `ci_failed` round for its author, with the failing checks (names, links, summaries) as feedback, whatever the ticket's status; the work state raises it once per head commit.

Their ids are stable (`pr.conflicted:<repo>#<n>:<head sha>`, source `workstate`), so each is raised once per head commit. They are recorded with `store.recordEvent` before the new state is saved, then handed to the handlers registered with `onEvent` (the engine, or the pipeline, as the mode says); a handler failure leaves the event unprocessed, and intake redelivers it. The first rescan of a pull request the work state did not know only sets a baseline and raises nothing.

**When a ticket entered its status.** Each ticket records `statusSince`, when it entered its current status: the time of the tracker event that moved or created it, else the tracker's last update of the ticket when a rescan finds the change. It stays while the status stays; a move event restarts it even when the status reads the same (the ticket left and came back between two reads), but never back in time. Ordering uses these timestamps, never ids. A ticket also keeps the tracker's `priority` when the adapter reports one (`Issue.priority`, 1 the most urgent). `readyTickets(person)` lists the ready tickets an agent could start next, for the idle pull.

**Polling.** CI results and mergeability arrive without events, so `start()` rescans open pull requests every `refreshIntervalMs` (default 60 seconds) and `rescan()` does it on demand. A rescan also finds pull requests that were merged or closed while the office was down, and the tickets assigned to the team's people. Finished tickets and closed pull requests are forgotten after 14 days.

**Queries.** Besides the `WorkflowState` methods, the last agent who worked on a ticket comes from the work item history (items whose subject is the ticket, or one of its pull requests, that have left the queue), and the requester is the latest trusted human who created the ticket, assigned it, or sent it back with a review or comment on its pull request (by event time; a code host login is mapped to the human's tracker identity through `humans:`). With no requester on record, `requester` falls back to the first human in `humans:`; with no `humans:` list the assignment is skipped and the engine logs a warning that names the ticket. `currentWork(person)` returns the person's tickets and pull requests with status, CI, mergeability, unresolved threads and links, and `formatCurrentWork` renders it as a few lines for the agent's session context.

## Agent-to-agent questions

`ost ask <handle|role> "<question>"` lets an agent ask a teammate and carry on with the answer. The office routes the question, keeps it as a conversation in the store, and mirrors it to humans.

**Routing.** A handle goes to that person. A role goes to the least busy person with it, measured as queued plus active work items, with ties broken by the order in `team.yaml`. Asking your own role means a peer, so the asker is left out. A role nobody has (or a role only the asker has) is not dropped: the asker gets an error saying `no devops on this team; ask a human`. The roster is read from the live team on every question, so hires and departures need no restart.

**A question is a work item.** The office creates a `conversations` row and a child work item for the target (kind `question`, trigger `agent`, parent = the asker's current item, subject = the conversation). The item goes through the scheduler like any other, so the loop guard applies: an item that keeps cycling through ask and answer is blocked by `agent_loop_guard`. The first journal entry of the child item says who asks (handle and role), the question and its id, the asker's work item and ticket, and how to answer (`ost answer <question-id> "<answer>"`, the `question_answer` tool). A question can only be asked from inside a work item, because the answer needs somewhere to go.

**Depth limit.** Questions asked while answering a question nest. The depth is the parent conversation's depth plus one, and a question beyond the limit (default 3) is refused with a message telling the agent to decide or ask a human.

**Answering.** Only the target of a question can answer it, once. The answer is stored, written to the journal of the asker's original item, and the item is resumed: a waiting item goes back to the queue and continues its session with the answer in its journal, a finished item gets a follow-up item that takes over its session, and a queued or blocked item keeps its place and sees the answer on its next run. If the asker is still running when the answer comes, the answer is stored as not yet delivered; when the asker hands back as waiting (or done), the office queues the item again (or starts the follow-up) with the answers in its journal and marks them delivered, so an answer cannot be missed by a race. The protocol server calls `messaging.onHandBack` after every hand-back for this.

**Mirroring.** Every question and answer is mirrored to humans. If the chat adapter exists and `office.channel` is set, the office posts to that channel. Otherwise it comments on the ticket of the asker's item when it has one. The asker's journal always records where the text went, so nothing is invisible. A failing channel or tracker falls through to the next option and never fails the question.

**Roster.** `ost team` (`ost roster`) shows the people with role title, busy or idle (or paused), what they work on, and the trusted humans. Titles and summaries come from the catalog when the office has it; otherwise the role id is shown.

## Chat requests and report-back

A trusted human asks an agent for something in chat; the agent's chat relay (see [The agent](/architecture/agent/)) sends the message to the office with `chat_message`, and the office decides. What follows is the chat desk's routing, which decides with the pipeline off or in shadow mode; live, the pipeline does (see [Chat in the event pipeline](#chat-in-the-event-pipeline)), and the desk keeps the filing verbs and the reports. The state lives in the store as subjects (`chat_origin` per item, `chat_thread` per thread, `chat_message` per message, `chat_log` with the latest messages of each thread), so it survives a restart. Each item also records its chat thread and message as [references](#wake-context).

**A new top-level message** becomes a chat session for the asked person: trigger `human`, kind `chat`, subject the thread. It ranks first in the queue and is offered at once, beside the active work item, so a question is answered while a review round runs. There is no "busy" reply and no placement question. Its origin (channel, thread, requester) is recorded and offered with the item. The office files nothing itself, since many messages are questions: the session decides. If all `policies.chat.parallel_sessions` sessions are taken the result is `limited`, the agent says so briefly, and the message starts when a session ends.

- **A question or a discussion:** the session answers in its last message, which is posted in the thread. No ticket, no work item, no queue.
- **Work:** the session files it. With a tracker it runs `ost ticket create` (`work_link`); without one it runs `ost work queue` (`work_queue`). The office then creates a work item in the same thread (kind `assigned` with the ticket as its subject, or kind `request`), with the thread's origin, and moves the thread to it; the session's origin records `filed` (the latest item) and `requests` (the requests filed so far). One message may hold several requests and each is filed once: before it creates a ticket the session sends `work_check`, which refuses a request the message already filed, so a refused filing leaves nothing in the tracker; the same request filed again is refused, and each request gets its own acknowledgement. Because the work item is created here, a ticket the agent creates and assigns to itself needs no tracker round trip: a `schedule` effect is skipped when the event's actor is the person to schedule, so the tracker echoing the agent's own ticket back produces no second item. The session has nothing to report; the work item reports its own result in the thread.
  - **Idle** (no other work item active or queued): the new item goes first and starts at once.
  - **Busy:** the new item waits last and is marked as awaiting a placement. `work_link_result` carries the person's other open work items in the order they run, so the agent posts the placement question with the grouped list.

- **Work that already exists:** a request about a ticket or pull request the person already has is attached to it, not filed as new work (`work_attach`, `ost work attach <ticket|pr>`). The office takes only the person's own work (a ticket assigned to them, a pull request they authored or whose ticket is theirs). The state of the work decides:
  - **Draft pull request, active ticket, or a ticket with no pull request yet:** the request joins the item already working on it (active, queued, waiting or blocked, which is retried), which keeps its place; if no item is, a `review_feedback` round on the pull request (or an `assigned` round on the ticket) is queued in the human class. Either way the human's message is stored as feedback of kind `chat` (an item that already has feedback keeps it, and the message is in its journal), the thread's origin is put on the item and the thread moves to it, so later replies join it. Nothing is asked about its place.
  - **Pull request in review** (open and ready, or approved; or a ticket in `review` without a pull request): refused unless the session passes `confirmed`, which it does after the requester said in the thread that the request belongs there. Until then nothing is queued and no ticket is created. If the requester wants a follow-up instead, the session files a new ticket.
  - **Merged or closed pull request, done ticket without an open pull request, canceled ticket:** always refused. Finished work is never reopened; the request is a follow-up.
  - **Open pull request whose ticket is done** (a merge into another pull request's branch closed it early): accepted like any open pull request, in review or not. The request attaches to that pull request, and the ticket goes back to active when the work starts. No ticket is created.

**The answer** is a reply in the thread of the waiting request. The office reads it with a small set of rules, not a model: _next_ (or _first_, _now_, _urgent_), _last_ (or _later_, _no rush_), _after_ a number from the list, a ticket key, a work item id or a title (after the running item means next, since a running item is never interrupted), and _PM_ or _prioritize_. A match moves the item with the scheduler's `move`; the agent's `ost work move` (`work_place`) does the same. _PM_ asks the team's `pm` role through the question routing with the request and the queue, and the item keeps waiting: the PM's answer reaches the item's journal but does not move it, the requester's answer does. An answer that matches nothing gets the question again. The item runs when its turn comes, so nothing is dropped.

**A reply in the thread of an item** attaches to it: the text goes to the item's journal and a waiting item is queued again, and a blocked item is retried as described in [Blocked work](#blocked-work), so the message joins the session on the next round. The thread belongs to the work item a session filed, so the answer to the placement question, and later replies, reach that item. A reply to a finished chat session continues its conversation in a new chat session; a reply to finished filed work starts a new chat session in the same thread. A reply in a thread the office does not know is a new request in that thread. Messages are remembered by id, so a message the platform delivers twice is handled once.

### Chat in the event pipeline

The routing above is the chat desk's. With `office.pipeline` the message is also an event ([decision 0016](/decisions/0016-event-pipeline/)):

- **Off:** the desk routes it, as described above. Nothing is traced.
- **Shadow:** the desk routes it and answers the agent as before. The message is then recorded by intake as `chat.message`, carrying what the desk did, and the pipeline judges it with the `chat_to_addressed` policy (a human's message wakes the agent it was written to, kind `chat`). The trace compares the two: a chat session the desk started (or holds as `limited`) is a `chat` wake of the agent on the conversation, a message that joined an item of the thread wakes that item's kind, and a placement answer wakes nobody. `ost explain --compare` sums it up.
- **Live:** the office records the message, adds it to the thread's log, and answers `received`; the agent posts nothing more. The pipeline's wake queues a chat session for the agent, with the thread's origin, the message as feedback of kind `chat`, and the message and the tickets it names as references, so the [wake context](#wake-context) and the filing verbs work as with the desk. Messages that follow within the [coalescing](#coalescing) window, or while the session is queued or running, join it. A message the platform delivers twice is recorded once.

Live, the desk is only the backend of the chat session's verbs (`work_link`, `work_check`, `work_queue`, `work_attach`), the reports (`chat_report`, the queued reports and `report_posted`) and `current_work`. Its routing (new sessions and their `limited` result, the placement answer and `asked_pm`, joining a reply to the thread's item, retrying a blocked item on a reply, and continuing a finished session's conversation) stays for the off and shadow modes, and goes when live is the only mode, with the `chat_message` and `chat_thread` routing subjects and the `limited`, `placed`, `asked_pm`, `unclear` and `joined` results. Live, every message starts or joins a chat session on its conversation: a reply to finished work starts a new one, which gets the thread's messages through its wake context, and the requester's answer to a placement question reaches a chat session too, not the waiting item, so the session moves the item with `ost work move`.

**Report back.** `chat_report` is a claim: the office answers whether the agent should post, once for each ending of an item (`result` for a finished item, `blocked`, `failed` once per item), together with the requester and the links of the item: its ticket, if the agent made one, and the pull requests that implement it. The first reply is a claim of its own (`ack`), made when the session files its work. A retried hand-back or a restart cannot post twice. An item the scheduler blocks on its own (loop guard, stale twice, too many failures) is routed in the same way as a blocked hand-back and the thread of a chat item always hears from its agent; the office posts nothing about it. Follow-ups are items of their own without a chat origin, so a review round or a question reports nothing until the requester's item finishes.

**The office never posts to people.** Every message a human reads in chat comes from an agent, as itself. The office only decides and records. A chat item's result goes to the thread it came from, and a blocked item is reported by the agent only when the team routes blocked work to the agent (see [Blocked hand-backs](#blocked-hand-backs)); the agent posts it right after the hand-back, done by the runner and not by the model.

**If the agent is offline.** The office records the report the agent owes (the hand-back summary or block reason, links and time) in the store, per person, when the item ends or is blocked. If the agent claims it with `chat_report`, nothing is left in the queue. If not, because the agent died or was offline, or because the scheduler blocked the item and there was no hand-back, the report waits. The office sends the queue to the agent in the `welcome` of each connection and pushes new reports with a `reports` message while it is connected. Each report has an id; the agent posts it as itself (in the item's chat threads, or in a direct message with the requester for a blocked item that did not come from chat), skips an id it posted already, and confirms with `report_posted`. Only then does the office drop it, so a crash while posting sends it again. The office posts nothing, and a late `chat_report` for a confirmed ending is answered with `post: false`. The queue is in the store, so a restart of the office keeps it. An agent without a chat port posts nothing.

### Blocked hand-backs

When an agent hands an item back as `blocked` (or as `done` on a ticket it left blocked), the preset rule `hand-back-blocked-to-requester` moves the ticket to `blocked`, assigns the requester, and routes the rest by `policies.hand_back.blocked_notify`. Live, the policy `hand_back_blocked` makes the move and the assignment; the PM's `unblock` round on a blocked hand-back is not in the default set yet. An item the scheduler blocks is routed as below in every mode.

- `pm` (the default when the team has a PM role): the rule schedules an `unblock` round for the PM. The round is about the ticket, and carries the blocked agent and its last comment on the ticket (its hand-back summary when the ticket has no comment) as feedback, which the PM reads as data. The PM follows the catalog process `process/unblock.md`: try to unblock (answer, `ost ask` a teammate, re-plan) and give the ticket back to the agent, and only when a human is needed hand back as blocked with a final message that the PM's agent sends to the requester. The thread of a chat item always gets its agent's reply, whatever the switch says; the switch governs only the direct message for work with no chat origin. An item the scheduler blocked takes the same two routes, with the block reason as the data. An `unblock` round never moves or assigns the ticket and does not make the PM the agent who last worked on it, so a trusted human's comment on the ticket still sends it back to the blocked agent.
- `agent`, and always for a team without a PM or when the blocked agent is the PM: no round is scheduled. The blocked agent tells the requester itself, right after the hand-back: in the thread of a chat item, otherwise in a direct message with the requester of the ticket (the first human when the ticket has none), with the ticket linked and what is needed. The direct message is opened by the agent's own chat identity, from `humans[].identities.chat`.

## Event pipeline

**Proposed** ([decision 0016](/decisions/0016-event-pipeline/)). The pipeline (`packages/office/src/pipeline`) judges each event against the team's policies: the [default set](/reference/pipeline-policies/) in order, with `pipeline.policies` applied. A `pipeline.policies` entry it cannot use (an unknown id, an instruction with an unknown variable) is logged as a warning when the office starts, and the default stays.

**What it judges.** Every event intake delivers, after the work state applied it; the work state's own `pr.conflicted` and `pr.ci_failed`; `chat.message`; `agent.handed_back`, which the office raises when an agent hands an item back; and `agent.idle`, which the [idle pull](#idle-pull) raises. Two kinds are dropped before any policy is evaluated: an event from an untrusted human, and an inline comment of a review that is still pending. An event no policy matches is dropped with `no policy matched`.

**The trace.** Every judged event gets one trace in the store, under the event's `<source>:<externalId>`: each policy that listens to it, whether it matched and why, the first condition that failed, and the decisions. In shadow mode it also records what the engine applied for the same event and how the two compare; live, the work item each wake queued or was folded into and the result of each act; in both, what the [wake context](#wake-context) carried. `ost explain` prints a trace, `ost explain --compare` sums up the comparison, and the [office link](#office-link) serves both.

**Shadow.** The pipeline judges each event before the engine applies anything, so both judge the same state, then records what the engine did. It never throws, so it cannot hold up or fail the engine.

**Live.** The pipeline judges instead of the engine.

- A **wake** queues a work item for the person through the scheduler, with the trigger of the event's actor (an idle pull is `automation`), the event's feedback, its references, and the instruction as the item's first journal line, written by `office`. Wakes for the same person and subject [coalesce](#coalescing). A chat wake queues a chat session with the thread's origin, as the desk would.
- An **act** is made by the office with its own tracker and knowledge ports, for the agent it names: the changes, then the policy's note as a comment on the ticket, saying whom they were for. Each act is made once per event and policy; its result goes on the trace, so a redelivered event does not repeat it.
- Errors propagate, so intake delivers the event again; the trace, the queue and the acts are idempotent per event.

The engine's item hooks still run live: moving a ticket to active when its work starts, follow-up rounds, and routing an item the scheduler blocked. What the engine's rules do that the default set does not yet is listed in [Modes](/concepts/automation/#modes).

## Engine

With `office.pipeline` off or in shadow mode, the engine decides. Live, only its item hooks run (see [Event pipeline](#event-pipeline)).

The engine (`createEngine`) is the glue between what happened and what the office does about it. It receives every event after the work state has applied it, asks the workflow what to do, and carries out the answer.

```ts
const engine = createEngine({
  store,
  workState,
  scheduler,
  team,
  clock,
  logger,
  ports: { tracker, chat },
});
intake.onEvent((event, meta) => workState.apply(event, meta)); // first, so the state is current
intake.onEvent((event, meta) => engine.handle(event, meta).then(() => undefined));
workState.onEvent((event, meta) => engine.handle(event, meta).then(() => undefined));
```

For each event it computes `evaluateWorkflow(event, workState, resolveWorkflow(team.workflow))` and applies the resulting effects in order:

| Effect     | What the engine does                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `move`     | `tracker.transition(ticket, status)`.                                                                                                                                                                                                                                                                                                                                            |
| `assign`   | `tracker.assign(ticket, member)`. Agents map through `people[].identities.tracker`; humans are looked up among the tracker's members by id, username or name.                                                                                                                                                                                                                    |
| `comment`  | `tracker.comment(ticket, body)`. The body is already rendered by the workflow. Comments on pull requests are skipped until the VCS port can post them.                                                                                                                                                                                                                           |
| `schedule` | `scheduler.enqueue`. The trigger comes from the event's actor (`human`, `agent`, `automation`; `schedule` for cron events). The subject is the pull request (`workState.prSubject`) when the effect has one, else the ticket. `high` and `low` priority sit five below and above the trigger's class. The parent is the person's latest item on the same ticket or pull request. |

After a `move` or `assign` the engine refreshes the ticket in the work state straight away, so the next event is judged against the ticket as the engine left it instead of waiting for the tracker's echo.

**No duplicate work.** A `schedule` is skipped while the person already has a queued or active item of the same kind on the same subject.

**Missing ports.** Without a tracker the `move`, `assign` and `comment` effects are skipped. Scheduling does not need it. Each skipped effect is recorded with the reason.

**Untrusted events.** An event with `meta.trusted === false` or `data.untrusted` is never evaluated, so it cannot cause any effect.

**Idempotent under redelivery.** Before applying anything the engine stores the plan (the evaluated effects) under the event's `source:externalId` as a subject of type `engine`, and records each effect's outcome (`applied`, `skipped` or `failed`, with a note and a time) as soon as it is done. A redelivered event, whether from intake's retry or from a synthetic event arriving through both intake and `workState.onEvent`, replays the stored plan and does only what is left. The state has usually moved on by then, so re-evaluating could change the effects and their positions. Transient port errors (`rate_limited`, `unavailable`) fail the handler so intake redelivers with backoff; other port errors are recorded as `failed` and do not hold back the remaining effects. If the office dies between performing an effect and recording it, that single effect can run again; moves and assignments are naturally repeatable, and a comment can be posted twice.

**Explaining a rule.** `ost workflow explain '<event-json>' --state '<json>'` runs `explainWorkflow` against the team's workflow and a static snapshot and prints, for every rule, whether it matched and why. See the [CLI reference](/reference/cli/).

## Office identities

The office acts under its own name on every system it uses, named `<team>-outstaff-office`:

- **Code host:** a read-only GitHub App (`GH_OFFICE_APP_*`). All reads go through it, and agents hold it too to clone read-granted repositories.
- **Tracker:** its own member account (`ITSAPLAN_API_KEY` in the office scope), so its comments and assignments are visibly the office's. Live, the pipeline's acts are made with it too, each with a note naming the agent it was for. This is the office's only write scope: ticket status, assignment, labels, parent links and those notes.
- **Chat:** none, unless the team sets `office.channel`. The office posts to no person; the only thing it ever writes to chat is the mirror of agent-to-agent questions and answers in that team channel, through its own Slack app (`SLACK_OFFICE_BOT_TOKEN`), which has no app-level token because the office never listens to chat. Without `office.channel` the office has no chat port and needs no chat app; with it, `createOffice` creates the port in office scope and stops at startup with an error naming `SLACK_OFFICE_BOT_TOKEN` when the token is missing.

**Why per-team apps.** Outstaff hosts no shared keys. A shared app would hold every team's installation behind one credential, and revoking or auditing one team would touch all. With one app per team, the team owns the credential, its permissions and its audit trail, and can remove it at will.

**Why read-only is safe.** The office never writes code: it reads pull requests, reviews and CI to keep work state, and agents write through their own Apps. A leaked office key can read the repositories it is installed on, but cannot push, merge or comment, and the office's chat token cannot join channels it was not invited to or act as a person. Give the office App only the permissions in the setup guide, and install it on the repositories in `repos`.

`ost validate` also checks the identities written in team.yaml: each adapter validates the ones it owns (a Slack member id, a GitHub login for humans and an App bot login `<slug>[bot]` for agents, a non-blank tracker identity) and reports located warnings. See the [validation codes](/reference/validation-codes/).

## Running the office

`createOffice` assembles the parts above into one process, and `outstaff-office` (the `bin` of `@outstaff/office`) starts it from the environment. The office image runs that command.

**Wiring.** The office creates its ports from `integrations` in team.yaml through the adapter registry, with the office-scope secrets. Version control is required; the tracker and chat are used when configured. An adapter that is configured but not installed in the image stops the start with a message naming it. Events then flow in one fixed order, as in [How an event flows](#how-an-event-flows): intake records an event, the work state applies it, then the pipeline and the engine judge it as `office.pipeline` says. The work state's own `pr.conflicted` and `pr.ci_failed` skip intake and are judged the same way. Every item the engine, the messaging or an agent queues goes through the scheduler, which tells the protocol server so the agent is offered the work at once. An item of kind `conflict` starts with the rebase steps for its pull request, including the pull requests stacked above it, in its journal.

**Offers.** What was offered and what the agent accepted is stored (as `offer` subjects), so a restart offers again only what was not accepted. The offer carries the item's journal, the ticket and pull requests it concerns with their links, and `ost work` shows the agent's open items. When an agent hands an item back as `done`, the office raises `agent.handed_back` for the ticket, so the rule `hand-back-to-requester` (live, the policy `hand_back_done`) moves it to review and assigns the requester. A `done` hand-back on a ticket that is `blocked` is treated as `blocked`: the ticket stays blocked, goes to the requester, and is routed as a [blocked hand-back](#blocked-hand-backs). The office does not move a blocked ticket to active when work on it starts, so a retry that is still blocked leaves it blocked; the agent runner also hands back as `blocked` an item that ends with its ticket still blocked in the tracker, when the agent moved nothing and asked nothing. When an item of a person finishes the work on a ticket that is no longer blocked, that person's earlier blocked items on the ticket are closed (canceled), so none is left behind. A repeated hand-back repeats nothing. The runtime session an agent reports for an item is stored with it and goes on the next offer. An agent that restarts gives back the items it had accepted with `decline`: they stay as they are (same run, journal and session, no new attempt) and are offered again. Agents report their usage windows with `usage`; see the usage policy above.

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

**Proposed** ([decision 0016](/decisions/0016-event-pipeline/)). With `link.url` in team.yaml and the secret `OUTSTAFF_LINK_TOKEN`, the office connects out over a WebSocket to a monitoring or management service, a dashboard for example. The service keeps no office data: it asks the office for people, events, one event's trace, work items, its health with the doctor checks, and the shadow comparison (`compare`), and the office tells it when people, traces or items change. An office that is offline shows nothing. See the [office link protocol](/reference/office-link/).

### Logs

One JSON object per line on standard output, with `time`, `level` and `message`. `OUTSTAFF_LOG_LEVEL` sets the lowest level written (`debug`, `info`, `warn` or `error`; default `info`). See [What the logs say](#what-the-logs-say) for which lines appear at which level.
