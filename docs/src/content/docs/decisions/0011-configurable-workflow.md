---
title: "0011: Configurable workflow"
description: Statuses and automations are configuration with presets.
sidebar:
  order: 11
---

**Status:** accepted

## Context

Teams name their statuses differently and want different automations. Hard-coded transitions such as "an open pull request moves the ticket to In Review" don't survive the second team.

## Decision

**Canonical statuses:** backlog, ready, active, review, blocked, done and canceled, each mapped to the tracker's own names.

**Automations are rules:** `on <event> [if <condition>] do <actions>`.
- Events include `pr.opened`, `pr.merged`, `pr.review_submitted`, `pr.conflicted`, `pr.ci_failed`, `ticket.assigned`, `ticket.moved`, `agent.handed_back`, `agent.asked` and `schedule.cron`.
- Actions are move, assign, comment, schedule and notify.

**Presets:** `kanban`, `scrum` and `minimal`. Every rule can be overridden.

**The `kanban` preset includes:**
- a human review sends the ticket back to the pull request's author;
- conflicts after a merge go to the authors of the affected pull requests, with the stack listed bottom first;
- a ticket moved to active while assigned to a human goes to the agent who last worked on it;
- a hand-back assigns the human who asked for the work.

**Inspection:** `ost workflow explain <event>` shows which rules fire.

## Consequences

- Team-specific behaviour is configuration, reviewed like code.
- Every preset rule has fixture tests.
