---
title: "0029: A teammate's review wakes the author, as a human's does"
description: A review or comment on an agent's pull request by a trusted human or a teammate agent wakes its author; policies.feedback.from narrows it to humans.
sidebar:
  order: 29
---

**Status:** accepted. Replaces the rule of [0016](/decisions/0016-event-pipeline/) (and of [0011](/decisions/0011-configurable-workflow/) before it) that only a human's review or comment on an agent's pull request wakes its author.

## Context

An agent reacted to feedback on its pull request only when a human gave it. A teammate agent's review or comment, such as the architect requesting changes on a developer's pull request, was recorded and dropped ("no policy matched"), and the pull request sat until a human commented.

## Decision

- **A trusted human's or a teammate agent's review or comment on an agent's pull request wakes its author**: `review_feedback` while it is open, `merged_feedback` once merged (`review_to_author`, `merged_feedback_to_author`). The instruction names who left it.
- **Never for the author's own comments or reviews**, so replying in its own threads does not wake it again; nor for the office's automation or a host's bot, nor for an approval with no text, which is a sign-off.
- **Untrusted people still wake no one.** Their events are recorded and dropped before any policy, whatever the setting.
- **The team decides who counts:** `policies.feedback.from` is `humans_and_teammates` (the default) or `humans`, which keeps the earlier rule. The `feedback_actor` condition reads it, so a team's own `when` can use it too.

## Consequences

- An agent reviewer's feedback reaches the author without a human in between. A wake from it is agent-triggered work, so the loop guard (`agent_loop_guard`) limits it.
- This alone starts no back-and-forth between agents: the author's replies wake nobody, and nothing wakes the reviewer again when the author answers or pushes. A review process that does is a separate decision.
- The catalog's review loop tells the author to weigh a teammate's review on its merits; only a trusted human's feedback is a direction.
