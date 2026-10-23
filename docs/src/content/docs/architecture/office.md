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

### Cursors, dedupe and restarts

Each source keeps an opaque cursor in the store and sends it with the next poll, so a restart resumes where it stopped. The cursor only moves after the whole page was recorded. Every event is also recorded by `(source, externalId)`; a repeat is dropped. So a crash mid-page, a replayed page or a webhook redelivery never produces a second event.

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
