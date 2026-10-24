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

- a trusted human's review or comment on an open agent-authored pull request is scheduled for the author as `review_feedback`, whatever the ticket's status and even with no linked ticket (`human-feedback-back-to-author`); an approval with an empty body is a sign-off and is not feedback; the item carries the review or comment that triggered it (who, kind, link, body), and the work prompt names it;
- the same feedback also assigns the author and moves the ticket to `active`, but only when the ticket is in `review` or `blocked` (`human-feedback-reactivates-ticket`); `scrum` does the same, and `minimal` schedules and assigns without moving anything;
- the same feedback on a merged agent-authored pull request is scheduled for the author as `merged_feedback` (`merged-feedback-follow-up`, in all three presets, with the `pr_merged` condition); a bare approval is not feedback, and the item carries the feedback in the same way. Nothing is assigned or moved: the ticket is not reopened. The catalog process (`process/merged-feedback.md`) has the agent answer on the merged pull request and, if a change is asked for, open a follow-up pull request from the default branch that links the original and the feedback (with a tracker it is linked to the original ticket; whether a new ticket is made is left to the role);
- conflicts after a merge go to the authors of the affected pull requests, with the stack listed bottom first;
- a ticket moved to active while assigned to a human goes to the agent who last worked on it;
- a hand-back moves the ticket to `review` and assigns the human who asked for the work, unless the ticket is already `done` or `canceled`.

**Inspection:** `ost workflow explain <event>` shows which rules fire.

## Consequences

- Team-specific behaviour is configuration, reviewed like code.
- Every preset rule has fixture tests.
