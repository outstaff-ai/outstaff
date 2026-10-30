---
title: "0019: Agents make the pipeline's acts as themselves"
description: An act goes to the agent it is for, whose own process makes the changes with its own tracker and knowledge credentials; the office's tracker account only reads.
sidebar:
  order: 19
---

**Status:** accepted. Replaces "the office acts as itself" of [0016](/decisions/0016-event-pipeline/) and meets the open point of [0018](/decisions/0018-pipeline-only/).

## Context

The pipeline's `act` decisions (move, assign, comment, set parent) were made by the office with its own tracker account, with a note naming the agent they were for. Ticket history then showed three kinds of author: humans, agents, and the office doing things for agents. Questions between agents were mirrored on the asker's ticket by the office's account too. Every agent already runs a long-lived process (`ost-agent`) with its own tracker and knowledge credentials, connected to the office.

## Decision

- **The agent makes its acts.** The office sends an act to the agent it is for over the agent connection (`act {id, ops}`). The agent's process, not a model run, makes the changes with its own tracker and knowledge ports, in order, stopping at the first that fails, and answers with `act_result {id, ok, results, error}`.
- **An offline agent makes it when it connects.** Acts are kept per person in the office store until the agent answers, sent at once while it is connected and again in each `welcome`, the way queued reports are. The agent answers an id it already made without making it again.
- **The office follows from the answer.** It reads the tickets the act changed again, so later decisions see the change before the tracker's feed reports it, and records the act on the event's trace as queued, delivered, then done or failed with one line per change.
- **The office's tracker account only reads.** It has no write path: acts go to agents, and the mirror of a question or answer on a ticket is a comment act of the asking agent.

## Consequences

- Ticket and document history show only humans and agents.
- An act for an agent that is down waits for it. Holding every agent's tracker key in the office, so acts run when the agent does not, stays possible later (as an `office.act_via: office` switch) if the delay turns out to matter.
- Delivery is at least once: an agent that crashes after making an act's changes and before its answer arrives makes them again when the act comes back, so a comment can repeat.
- The office's tracker key can be read-only, where the tracker offers that.
