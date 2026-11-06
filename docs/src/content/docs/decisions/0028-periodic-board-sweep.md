---
title: "0028: The office sweeps the board and wakes the PM with what is out of step"
description: Every policies.reconcile.every the office checks the open tickets against the facts it already has, and wakes the PM once with the ones whose status or assignee disagrees.
sidebar:
  order: 28
---

**Status:** accepted. Builds on [0027](/decisions/0027-stale-blocks-resolve-themselves/), which reacts to events; this adds a periodic check for what no event reached.

## Context

Events miss things: a ticket left in review after its pull requests merged, a blocked ticket whose blockers closed while the office was down, an active ticket whose round was lost, a parent still open after its sub-tickets closed. Each stays wrong until a human notices. The office already holds the facts that show it: the tickets' statuses, assignees and links, the pull requests and their merge checks, and the agents' work.

## Decision

- **The work state sweeps the board on the office's poll.** Every `policies.reconcile.every` (default 2 hours, `off` to turn it off), it checks the open tickets in active, review and blocked against its own records, with no model and no reads, and lists the ones out of step, each with the facts: pull requests all merged or closed, blockers all closed, a failed merge check that passed later, a block that sat with a human for `stale_hours`, an active ticket nobody works on, a parent whose sub-tickets are all closed or in review.
- **The PM is woken only when there is something to fix**, once per sweep, with the list (`board.stale`, `stale_board_to_pm`, kind `reconcile`). She puts each ticket right as herself, with one line on it saying why, and leaves the ones that are fine. A ticket is listed for the same reason at most once a day.
- **It reuses the work state's timer** that follows the merges; no scheduler of its own.

## Consequences

- A quiet board costs a pass over the office's records and nothing else.
- The facts are the office's: the PM checks each one against the ticket before she acts, and a ticket that is fine for a reason the office cannot see is listed again a day later.
