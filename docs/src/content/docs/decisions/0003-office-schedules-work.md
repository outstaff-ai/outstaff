---
title: "0003: The office schedules all work"
description: One office per team schedules work; agents connect out; the tracker is optional.
sidebar:
  order: 3
---

**Status:** accepted

## Context

There are two simpler ways to start agents, and both break down.

**Let the issue tracker start them.** Every agent wakes on every status change. Assignment then depends on what the tracker allows. Pull request events need CI jobs, and those jobs often can't reach a self-hosted tracker.

**Let agents react to events on their own.** No single place knows the state of all the work, so loops and stalls go unnoticed.

## Decision

Each team runs one **office** container.

**Intake.** The office takes in events from the code host, the tracker and chat:
- by **polling** (the default, which works behind NAT);
- or by **webhooks**, when the office is reachable.

**Work state.** It keeps current state for every ticket, pull request, CI run, review and stack, linked to the people involved.

**Workflow engine.** Rules decide what each event means (see [0011](/decisions/0011-configurable-workflow/)).

**Work items.** Anything that needs a person becomes a **work item**: an assignment, a review round, a conflict, failing CI, a question from another agent, a chat request, or a scheduled job.

**Scheduling.** The office schedules work items per person:
- human chat first, then human-triggered work, then agent-triggered work, then scheduled work;
- a **loop guard** limits only runs triggered by agents or automation;
- a **usage policy** defers scheduled work, then pauses automatic work, as LLM usage limits approach;
- humans are always answered.

**Agents connect out.** Agents open an outbound connection to the office. They need no inbound port, and the office needs no access to their containers.

**Messaging.** Agents ask each other questions through the office (`ost ask`). The question becomes a child work item, and the answer resumes the asker's work.

**The tracker is optional.** Without one, work items in the office are the record. With one, agents keep their tickets in sync.

## Consequences

- No CI jobs or self-hosted runners are needed in client repositories.
- The office needs its own identities: a read-only code-host app, a tracker account and an optional chat bot, each named `<team>-outstaff-office`.
- The office is stateful (see [0007](/decisions/0007-store-postgres-and-sqlite/)).
