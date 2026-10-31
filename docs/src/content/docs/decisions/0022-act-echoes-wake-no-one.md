---
title: "0022: The tracker's echo of an act wakes no one"
description: An act's changes come back from the tracker as the acting agent's events; the office recognises them, and the event that caused the act is the only one that decides whom to wake.
sidebar:
  order: 22
---

**Status:** accepted. Follows from [0019](/decisions/0019-agents-make-their-acts/).

## Context

Since 0019, the agent an act is for makes its changes with its own tracker identity. The tracker reports those changes back to the office like any other: a blocked hand-back assigns the ticket to the team's PM as the blocked agent, and the tracker says "assigned to pia by sam". That is exactly what a teammate's assignment looks like, so `assigned_to_assignee` woke the PM a second time, with kind `assigned`, on top of the `unblock` wake the hand-back decided. Any act that assigns a ticket to another agent did the same. Before 0019 the office's own account made the change, and an event of the office's account woke no one.

An assignment made by an agent cannot simply wake no one: when the PM assigns the ticket back to the blocked agent, that assignment must wake it.

## Decision

- **The office recognises the echo of its own acts.** When the act desk sends an act, it records each tracker change the act makes (a move, an assignment, a comment on a ticket) against the ticket, before the agent has it, because the tracker may report the change before the agent answers. A tracker event is the change's echo when it is the first event of that kind on that ticket by the acting agent that shows what the change leaves: the assignee or status in the work state after the event, the comment's body. Each change is recognised once (the same event delivered again stays its echo) and is expected for a day.
- **The echo carries the act's id** in its data (`echo`), so its trace says which act it came from.
- **An invariant of the aggregation: an act's echo wakes no one.** The event that caused the act already decided whom to wake. A wake any policy proposes on an echo is rejected with that reason. Acts on an echo are judged as on any event.

## Consequences

- A blocked hand-back wakes the PM once, with `unblock`; the PM's own assignment back to the blocked agent wakes it as before.
- The guard holds for every policy, built-in or custom, without a condition of its own.
- A change the tracker never reports, such as a move to the status the ticket already has, stays expected for a day: the same agent's next event of that kind on the ticket that shows the same result is taken as its echo and wakes no one. Agents' moves and comments wake no one anyway; an agent assigning a ticket to the person an act just assigned it to is the only case it hides.
