---
title: "0020: The office marks a ticket active for the agent when its work starts"
description: Starting a round on a ticket is bookkeeping the office does for the agent, as the agent, not a duty in the agent's instructions.
sidebar:
  order: 20
---

**Status:** accepted. Replaces the point of [0018](/decisions/0018-pipeline-only/) that a woken agent takes its ticket back and moves it to active itself.

## Context

0018 removed the engine's hidden side effects. One of them, moving a ticket to active when its work starts, was handed to the agent: every round began with the agent assigning the ticket to itself and moving it. That is pure bookkeeping, and the agent can forget it. The agent's own tracker calls also reach the office only on its next poll, so a decision made right after them, such as judging a hand-back, saw a stale ticket.

The rule the office follows is that it acts on its own only for bookkeeping, and anything that needs judgement wakes the agent. Starting work is bookkeeping.

## Decision

- **A new office event, `agent.started`,** is raised when an agent accepts a work item on a ticket, or on a pull request with a ticket. The office reads the ticket from the tracker again before judging it.
- **The `start_marks_active` policy** acts as that agent for the kinds that work on a ticket (`assigned`, `review_feedback`, `ticket_comment`, `rebase`, `ci_failed`). It assigns the ticket to the agent and moves it to active, unless the ticket is done or canceled or already in that state.
- **After every act,** the office reads each ticket the act changed again, so the next decision sees them as the act left them.
- **The catalog no longer asks agents** to take their ticket back or move it to active at the start of a round.

## Consequences

- Agents spend no tokens or attention on starting bookkeeping, and the office's view of the ticket is current when the round starts.
- Accepting an item takes a few tracker calls longer before the agent gets its reply.
- A blocked ticket that a human sends back is made active when the agent picks it up. If the agent is still stuck, it blocks the ticket again itself.
