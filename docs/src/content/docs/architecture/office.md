---
title: The office
description: How the office takes in events, tracks work and schedules agents.
---

The office is one long-running process per team. It owns the store, talks to integrations only through adapters, and talks to agents only over the agent protocol. Each component below has its own section.

## Intake

Intake turns activity in your repositories and tracker into deduplicated, normalized events for the workflow engine.

### Modes

`office.events` in the team config selects the mode.

- **poll** (default). Every `office.poll_interval_seconds` the office asks the VCS adapter for events across all team repos and, if a tracker is configured, the tracker adapter. Each source polls on its own timer.
- **webhook**. The office listens for `POST /webhooks/vcs` and `POST /webhooks/tracker`. The adapter verifies the signature and parses the body; intake only does the HTTP. A bad signature gets `401`, a malformed body `400`, a source without adapter support `404`, an oversized body `413`. Adapters opt in by implementing the optional `parseWebhook(headers, body)` method of their port.

### What the logs say

Intake and the engine log at info level, so "the agent did not react" can be answered from the logs:

- `intake: recorded <source> <type> on <repo#n or ticket> by <actor> (trusted|untrusted)` for every event kept.
- `intake: dropped <source> <type> on <subject>: <reason>` for every event read but not kept. The reason is that the adapter does not map the event type, that the office does not map it (for example `pr.synchronize`), or that it is a duplicate.
- `engine: rule <id> matched <type> on <subject>: <effects>` for each rule that matched, then `engine: scheduled review_feedback for sam on acme/app#8` (or moved, assigned, commented, notified) for each effect that was applied, and `engine: no rule matched <type> on <subject>` when none did. Effects that were skipped or failed are warnings.
- A failed poll is an error. When a polled source has had no successful poll for `office.poll_warn_after_minutes` (default 10), each further failure also logs a warning with the minutes.

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

| Source event                               | Workflow event                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| pull request opened, merged, closed        | `pr.opened`, `pr.merged`, `pr.closed`                                                            |
| review submitted                           | `pr.review_submitted` (`data.state`)                                                             |
| pull request comment                       | `pr.comment`                                                                                     |
| ticket created, assigned, moved, commented | `ticket.created`, `ticket.assigned`, `ticket.moved` (`data.from`, `data.to`), `ticket.commented` |

Pushes to a pull request are not forwarded; `pr.conflicted` and `pr.ci_failed` come from the work state, not from intake. Every event carries `data.at`, the time the source reported.

### Who acted, and whether to trust them

Each event has an actor kind.

- **agent**: the VCS login matches a person's `identities.vcs` exactly (ignoring case), or the tracker member's id or username equals the person's `identities.tracker`. Nothing else makes an actor an agent, however its name looks, so an outside account cannot pass as one of your agents by naming itself after one. A person with a write grant but no `identities.vcs` triggers the `people.missing_vcs_identity` warning: their pull requests and comments are treated as an unknown human's.
- **automation**: any other login ending in `[bot]`, or a tracker member of kind `agent` that is not a team person.
- **human**: everyone else. A human is trusted when they have `write` or `admin` permission on the repository (looked up with `vcs.permission` and cached in the store for 10 minutes), or are listed in `humans:` when that list exists. Tracker members of kind `human` are trusted.

Events from untrusted humans are still recorded and delivered, but carry `data.untrusted: true` (and `meta.trusted === false` in the handler) so the engine never treats them as instructions.

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

### One active item per person

`next(person)` returns the next runnable item, or nothing while the person has an active item, while they are paused, or while every queued item is held back by a policy. An active item is never interrupted. `markActive(itemId)` starts a run and checks all policies again.

A human chat request starts at once when the person is idle. When the person is busy it waits last until the human chooses a position (`next`, after a given item, or last) or the PM re-prioritizes it with `move`.

### Reordering

`move(itemId, { before } | { after } | { last })` is the explicit reorder operation behind `ost work move <item> --before|--after <item>`. Only queued items of the same person can be moved. The queue is renumbered and stored, so the order survives restarts. If the target is in a different priority class, the moved item takes the nearest class that keeps the order valid.

### Loop guard

A run of an agent- or automation-triggered item is counted when it starts. When an item already had `policies.agent_loop_guard.max_runs_per_item_per_hour` runs in the last hour, it is blocked instead of started, and the reason is returned to the caller (and written to the item's journal) so the workflow engine can comment and notify. `tick()` also blocks queued items that tripped the guard. Human-triggered and scheduled runs are never limited.

### Failed runs

When an agent reports that a run failed, `fail(itemId, error)` ends the run as `failed`, counts a consecutive failure on the item, and puts it back in the queue with `not_before = now + min(base * 2^(n-1), cap)`. The defaults are 1 minute and 30 minutes (so 1, 2, 4, 8, 16, 30, 30 ...) and come from `policies.retry` (`base_minutes`, `cap_minutes`, `max_failures`). `next` skips an item whose `not_before` is still in the future, so the person's other queued items run meanwhile, and `markActive` refuses it with `backoff`. The count and `not_before` are columns of the work item, so a restart keeps them; nothing is a timer in memory. Every `tick()` clears the `not_before` that ran out and the office tells the agent there is work again.

After `policies.retry.max_failures` failures in a row (default 3) the item is blocked with the reason `failed N times: <first line of the last error>`. It goes through the same path as a loop-guard block: the reason is written to the journal and the office announces it to the requester and the person's chat. A successful hand-back (`done` or `waiting`) resets the count, and so does blocking, so a human who unblocks the item starts with a clean count. A stale run is not a failure; it keeps its own retry-once rule.

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
- Limits apply per credential. When several people share one subscription, list them in `policies.usage.shared` (for example `[[sam, kim]]`); a report from any member is stored for all of them. A person can be in one group only.
- `ost roster` shows each person's busiest window and when it resets, as long as the report is fresh.

### Stale runs

An active item with no heartbeat for `staleAfterMinutes` (default 10) is sent back to the queue once. If the retry also goes stale, the item is blocked with a reason. A good run in between resets the allowance. `heartbeat(itemId)` marks activity; `tick()` does the sweep, and `start()` runs it on the clock.

### Pause and resume

`pause()` stops the whole team from starting new work; `pause(person)` stops one person. Running items finish. `resume` mirrors it. Pauses are stored, so they survive restarts.

## Agent connection

Agents connect out to the office over a WebSocket, so an agent needs no inbound port. The office listens on one port, path `/agent`, and speaks the [agent protocol](/reference/agent-protocol/), which is defined once in the `@outstaff/protocol` package and used by both sides.

**Authentication.** Every person has a token, which the office reads from its secrets as `OUTSTAFF_AGENT_TOKEN_<HANDLE>` (the handle in upper case, `-` as `_`). The office hashes the tokens with scrypt when it starts and compares in constant time. A person without a token cannot connect. The agent sends `hello` with its handle, the token and the protocol version; a wrong token or a different protocol version closes the connection.

**One connection per person.** A new, valid connection replaces the old one. An agent that gets replaced does not reconnect on its own, so two copies of the same agent do not fight over the connection.

**Offers.** The office takes the next queued item for a person from the scheduler and offers it with its context: the journal, the subjects and links. Delivery is at least once. The server keeps no delivery state of its own: which items are offered and accepted is stored behind the work source, so it survives a restart. After a reconnect the office offers again what was not accepted, and `welcome` lists the accepted, unfinished items to resume. Messages about an item are idempotent by its id.

**Liveness.** The office tells the agent how often to send a heartbeat, and drops a connection that is silent for three times that long. The agent drops a connection when the office stops answering and reconnects with exponential backoff and jitter, starting from one second up to thirty.

**Boundaries.** The server depends on the scheduler only through the small `WorkSource` interface, and on question routing only through the optional `Messaging` interface. Frames are limited to 1 MiB, malformed or unknown messages get an `error` reply and never close the connection, and unexpected failures reach the agent as a generic `failed` error, with the detail only in the office log.

## Work state

The work state is the office's picture of the world: every live ticket and pull request, who owns it, whether CI is green, whether it merges cleanly, how many review threads are open, and which pull requests are stacked on which. It is built from intake events and from reading the ports, and it implements the read-only `WorkflowState` the workflow engine evaluates rules against.

**Source of truth.** The latest state of each ticket and pull request is stored as a subject (`ticket` / `pr`) and the relations as links: `pr implements ticket`, `pr authored_by person`, `pr stacked_on pr`, `ticket assigned_to person`. A `workstate/index tracks ...` link marks the records the work state keeps. On start the state is rebuilt from the store. Losing the store only costs a `rescan()`.

**Applying events.** `apply(event, meta)` is registered as an intake handler. It is idempotent: it re-reads the pull request (details, mergeability, checks, review threads) or the ticket through the ports, so applying an event twice, or out of date, converges on the same state. Reading what the ports say now, not what the event said, is what makes at-least-once delivery safe.

**Links.** A pull request belongs to the first ticket key the tracker knows among: a closing reference in the body (`Closes ACME-12`), the branch name, the title, then any other key in the body. Keys the tracker does not know are ignored. The author is matched to a person through `people[].identities.vcs`, the assignee through `identities.tracker`. A pull request whose base branch is the head branch of another open pull request is stacked on it; `stackedOn(repo, branch)` returns everything above the branch, bottom first.

**Derived events.** Two things happen without a platform event, so the work state raises them itself, as `pr.conflicted` and `pr.ci_failed` from the actor `workstate`:

- after `pr.merged`, every other open pull request in the repository is re-read waiting for the host to compute mergeability; one that now conflicts (including one that was still `unknown` before) raises `pr.conflicted`. If the host still has not decided, the next rescan catches it;
- when the checks of an open pull request turn to failure, it raises `pr.ci_failed`.

Their ids are stable (`pr.conflicted:<repo>#<n>:<head sha>`, source `workstate`), so each is raised once per head commit. They are recorded with `store.recordEvent` before the new state is saved, then handed to the handlers registered with `onEvent` (the engine); a handler failure leaves the event unprocessed, and intake redelivers it. The first rescan of a pull request the work state did not know only sets a baseline and raises nothing.

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

A trusted human asks an agent for something in chat; the agent's chat relay (see [The agent](/architecture/agent/)) sends the message to the office with `chat_message`, and the office decides. The state lives in the store as subjects (`chat_origin` per item, `chat_thread` per thread, `chat_message` per message), so it needs no migration and survives a restart.

**A new top-level message** becomes a work item for the asked person: trigger `human`, kind `chat`, so it ranks in the human-chat class, ahead of agent-triggered and scheduled work. Its origin (channel, thread, requester) is recorded and offered with the item. The office files nothing itself, since many messages are questions. When the request is work the agent creates the ticket (`ost ticket create`) and the office links it: `work_link` sets it as the item's subject, so the workflow moves it and finds its pull requests like any ticket's, and the engine does not queue a second item for a subject a live chat item is working on. More generally, a `schedule` effect is skipped when the event's actor is the person to schedule (an agent assigning a ticket to itself, or creating it assigned to itself, starts nothing), so the tracker echoing the agent's own ticket back never produces a second item, live or not. An item that already has a ticket or pull request as its subject refuses a second ticket. Until then, and for questions, the subject is the thread.

- **Idle** (no active item and an empty queue): the item goes first and is offered at once.
- **Busy:** the item waits last, and `chat_message_result` carries the person's other open items in the order they run, so the agent can list them with links. The item is marked as awaiting a placement.

**The answer** is a reply in the thread of the waiting request. The office reads it with a small set of rules, not a model: _next_ (or _first_, _now_, _urgent_), _last_ (or _later_, _no rush_), _after_ a number from the list, a ticket key, a work item id or a title (after the running item means next, since a running item is never interrupted), and _PM_ or _prioritize_. A match moves the item with the scheduler's `move`; the agent's `ost work move` (`work_place`) does the same. _PM_ asks the team's `pm` role through the question routing with the request and the queue, and the item keeps waiting: the PM's answer reaches the item's journal but does not move it, the requester's answer does. An answer that matches nothing gets the question again. The item runs when its turn comes, so nothing is dropped.

**A reply in the thread of an item** attaches to it: the text goes to the item's journal and a waiting item is queued again, and a blocked item is retried as described in [Blocked work](#blocked-work), so the message joins the session on the next round. A reply to a finished item starts a new chat item in the same thread that takes over the finished item's session and ticket. A reply in a thread the office does not know is a new request in that thread. Messages are remembered by id, so a message the platform delivers twice is handled once.

**Report back.** `chat_report` is a claim: the office answers whether the agent should post, once for each ending of an item (`result` for a finished item, `blocked`, `failed` once per item), together with the requester and the links of the item: its ticket, if the agent made one, and the pull requests that implement it. The first reply is a claim of its own (`ack`), made when the ticket is linked. A retried hand-back or a restart cannot post twice. An item the scheduler blocks on its own is announced by the office through its chat port, with the same claim, so the thread is not left in silence. Follow-ups are items of their own without a chat origin, so a review round or a question reports nothing until the requester's item finishes.

**If the agent dies after the hand-back.** The office records the hand-back of a chat item (summary, links, time) with its origin and starts a grace timer, `chatReportGraceSeconds` (default 60). If the agent claims the report in that time, nothing changes. If not, the office posts a short result itself through its own chat port, mentioning the requester: the hand-back summary cut to the team's `max_lines` (one line is kept for the note that the agent went offline), then the item's links. It makes the same claim the agent would, so whichever path claims first posts, and a late `chat_report` is answered with `post: false`. The record is in the store, so after a restart the office resumes the timers from the hand-back time. Without a chat port the office logs a warning and posts nothing.

## Engine

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
| `notify`   | `chat.post` to the requester's or assignee's direct channel (`humans[].identities.chat`, `people[].identities.chat`), or to a channel (`channel:<name>`, or `integrations.chat.channel`).                                                                                                                                                                                        |

After a `move` or `assign` the engine refreshes the ticket in the work state straight away, so the next event is judged against the ticket as the engine left it instead of waiting for the tracker's echo.

**No duplicate work.** A `schedule` is skipped while the person already has a queued or active item of the same kind on the same subject.

**Missing ports.** Without a tracker the `move`, `assign` and `comment` effects are skipped; without chat so are `notify` effects. Scheduling does not need either. Each skipped effect is recorded with the reason.

**Untrusted events.** An event with `meta.trusted === false` or `data.untrusted` is never evaluated, so it cannot cause any effect.

**Idempotent under redelivery.** Before applying anything the engine stores the plan (the evaluated effects) under the event's `source:externalId` as a subject of type `engine`, and records each effect's outcome (`applied`, `skipped` or `failed`, with a note and a time) as soon as it is done. A redelivered event, whether from intake's retry or from a synthetic event arriving through both intake and `workState.onEvent`, replays the stored plan and does only what is left. The state has usually moved on by then, so re-evaluating could change the effects and their positions. Transient port errors (`rate_limited`, `unavailable`) fail the handler so intake redelivers with backoff; other port errors are recorded as `failed` and do not hold back the remaining effects. If the office dies between performing an effect and recording it, that single effect can run again; moves and assignments are naturally repeatable, and a comment can be posted twice.

**Explaining a rule.** `ost workflow explain '<event-json>' --state '<json>'` runs `explainWorkflow` against the team's workflow and a static snapshot and prints, for every rule, whether it matched and why. See the [CLI reference](/reference/cli/).

## Office identities

The office acts under its own name on every system it uses, named `<team>-outstaff-office`:

- **Code host:** a read-only GitHub App (`GH_OFFICE_APP_*`). All reads go through it, and agents hold it too to clone read-granted repositories.
- **Tracker:** its own member account (`ITSAPLAN_API_KEY` in the office scope), so its comments and assignments are visibly the office's.
- **Chat:** its own Slack app (`SLACK_OFFICE_BOT_TOKEN`). It posts notifications and mirrors agent-to-agent questions, and reads channel history; it has no app-level token because the office never listens to chat. `createOffice` creates the chat port in office scope, and when `integrations.chat` is set without the office token it stops at startup with an error naming `SLACK_OFFICE_BOT_TOKEN`.

**Why per-team apps.** Outstaff hosts no shared keys. A shared app would hold every team's installation behind one credential, and revoking or auditing one team would touch all. With one app per team, the team owns the credential, its permissions and its audit trail, and can remove it at will.

**Why read-only is safe.** The office never writes code: it reads pull requests, reviews and CI to keep work state, and agents write through their own Apps. A leaked office key can read the repositories it is installed on, but cannot push, merge or comment, and the office's chat token cannot join channels it was not invited to or act as a person. Give the office App only the permissions in the setup guide, and install it on the repositories in `repos`.

`ost validate` also checks the identities written in team.yaml: each adapter validates the ones it owns (a Slack member id, a GitHub login for humans and an App bot login `<slug>[bot]` for agents, a non-blank tracker identity) and reports located warnings. See the [validation codes](/reference/validation-codes/).

## Running the office

`createOffice` assembles the parts above into one process, and `outstaff-office` (the `bin` of `@outstaff/office`) starts it from the environment. The office image runs that command.

**Wiring.** The office creates its ports from `integrations` in team.yaml through the adapter registry, with the office-scope secrets. Version control is required; the tracker and chat are used when configured. An adapter that is configured but not installed in the image stops the start with a message naming it. Events then flow in one fixed order: intake records an event, the work state applies it, the engine evaluates the workflow. The work state's own `pr.conflicted` and `pr.ci_failed` go straight to the engine. Every item the engine, the messaging or an agent queues goes through the scheduler, which tells the protocol server so the agent is offered the work at once. An item of kind `conflict` starts with the rebase steps for its pull request, including the pull requests stacked above it, in its journal.

**Offers.** What was offered and what the agent accepted is stored (as `offer` subjects), so a restart offers again only what was not accepted. The offer carries the item's journal, the ticket and pull requests it concerns with their links, and `ost work` shows the agent's open items. When an agent hands an item back as `done`, the office raises `agent.handed_back` for the ticket, so the workflow moves it to review and tells the requester; a repeated hand-back repeats nothing. The runtime session an agent reports for an item is stored with it and goes on the next offer. An agent that restarts gives back the items it had accepted with `decline`: they stay as they are (same run, journal and session, no new attempt) and are offered again. Agents report their usage windows with `usage`; see the usage policy above.

**Start and stop.** `start()` opens the agent connection, then the work state (with one rescan) and intake, which redelivers any events that were recorded but not handled. `stop()` stops intake, lets running handlers finish, closes connections and the store. `SIGTERM` and `SIGINT` do this.

### Environment

| Variable                                         | Meaning                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `OUTSTAFF_TEAM_FILE`                             | Path to team.yaml (or the folder holding it). Alternatively `OUTSTAFF_TEAM_REPO` and `OUTSTAFF_TEAM_REF`.            |
| `OUTSTAFF_STORE_URL`                             | `postgres://user:pass@host/db`, `sqlite:///var/lib/outstaff/office.db` (the default) or `sqlite::memory:` for tests. |
| `OUTSTAFF_AGENT_PORT`                            | Port agents connect to, path `/agent`. Default 8080.                                                                 |
| `OUTSTAFF_WEBHOOK_PORT`                          | Port of the webhook receiver when `office.events` is `webhook`. Default 8082.                                        |
| `OUTSTAFF_HEALTH_PORT`                           | Port of the health endpoints. Default 8081.                                                                          |
| `OUTSTAFF_AGENT_TOKEN_<HANDLE>`                  | One token per person, as a secret.                                                                                   |
| `OUTSTAFF_SECRETS_DIR`                           | Directory of secret files, default `/run/secrets/outstaff`; the environment is the fallback.                         |
| Adapter secrets (for example `GH_OFFICE_APP_ID`) | Whatever the configured adapters declare for the office scope.                                                       |

The SQLite file's folder is created when missing; mount a volume there. Use Postgres to run the office on a platform without persistent disks. Migrations run on start.

### Health

- `GET /healthz` is liveness: 200 while the office is starting or running and its parts (store, agent connection, work state, intake, scheduler) are up, 503 once something fails or it is stopping.
- `GET /readyz` is readiness: 200 only while the office is running.

Both answer with JSON: `{ "ok": true, "state": "running", "components": { "store": { "ok": true, "detail": "sqlite" }, … } }`. The same data is available in code as `office.health()`.

### Logs

One JSON object per line on standard output, with `time`, `level` and `message`.
