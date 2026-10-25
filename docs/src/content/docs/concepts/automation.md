---
title: What outstaff does on its own
description: Every automated behaviour, whether it is on by default, and the policies switch that controls it.
sidebar:
  order: 3
---

Outstaff acts without being asked in a few places: it reacts to messages, starts follow-up rounds, hands tickets back and retries stuck work. Each of these has a named switch under `policies` in `.outstaff/team.yaml`. Everything that happens today is on by default; a team that wants less turns a switch off. Anything that would merge, approve or act without a human in the loop will be off until a team opts in.

```yaml
policies:
  acknowledge: { chat: true, vcs: true }
  chat: { profile: true }
  feedback: { follow_up_round: true, merged_prs: true }
  hand_back: { reassign: requester, fallback: first_human }
  conflicts: { follow_up: true }
  retry: { on_signal: true }
```

Run `ost policies` to see every switch with its effective value and where the value comes from, and `ost workflow explain` to see which switch is behind each rule an event triggers.

## The behaviours

| Switch                              | Default       | What outstaff does while it is on                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies.acknowledge.chat`         | `true`        | Reacts with eyes to a chat message from a trusted person as soon as the agent has seen it.                                                                                                                                                                                                                                                                                   |
| `policies.acknowledge.vcs`          | `true`        | Reacts with eyes to each pull request comment the agent is about to answer, when its round starts. Needs a vcs adapter with `vcs.reactions`; `ost validate` warns when it lacks it.                                                                                                                                                                                          |
| `policies.chat.profile`             | `true`        | Publishes the agent's profile in chat (on Slack, the Home tab): its role, whether it is working or idle with when it was last active, and its current work grouped by ticket or pull request in queue order. Updates when the work changes and at least every 5 minutes while working. Needs a chat adapter with `chat.agentProfile`; `ost validate` warns when it lacks it. |
| `policies.feedback.follow_up_round` | `true`        | Starts another round when feedback arrived after the agent was offered its work, so nothing written during a round is lost.                                                                                                                                                                                                                                                  |
| `policies.feedback.merged_prs`      | `true`        | Schedules the author to answer a trusted person's review or comment on an already merged pull request, and to open a follow-up pull request if a change is asked for.                                                                                                                                                                                                        |
| `policies.hand_back.reassign`       | `requester`   | When an agent hands work back, moves the ticket to review (done) or to blocked and tells the person who asked (blocked), and assigns it to them. A waiting hand-back changes nothing. With `none` the ticket still moves and keeps its assignee.                                                                                                                             |
| `policies.hand_back.fallback`       | `first_human` | When a ticket has no known requester, uses the first human in `humans`. With `none`, a rule that needs a requester is skipped when the ticket has none.                                                                                                                                                                                                                      |
| `policies.conflicts.follow_up`      | `true`        | When a pull request starts to conflict with its base, for example after another one merged, sends it back to its agent author to rebase.                                                                                                                                                                                                                                     |
| `policies.retry.on_signal`          | `true`        | Retries a blocked work item when a trusted human moves its ticket, assigns it, reviews or comments on its pull request, or replies in its chat thread.                                                                                                                                                                                                                       |

`policies.retry` also holds the backoff settings (`base_minutes`, `cap_minutes`, `max_failures`) that decide when a failing item is blocked in the first place.

## Switches and workflow rules

Three switches act on preset [workflow](/reference/team-yaml/#workflow) rules: `feedback.merged_prs` removes `merged-feedback-follow-up`, `conflicts.follow_up` removes `conflict-back-to-author`, and `hand_back.reassign: none` drops the assignment from `hand-back-to-requester` and `hand-back-blocked-to-requester`. The others are carried out by the agent or the office and have no rule behind them.

Precedence, strongest first:

1. A rule in `workflow.rules` with the id of a preset rule. It replaces the preset rule (or, with `disabled: true`, removes it) whatever the switch says, so a team can write its own version of a behaviour and keep the switch off or on.
2. The switch in `policies`.
3. The built-in default.

A switch can only do something the workflow preset has. The `minimal` preset has no `conflict-back-to-author` or `hand-back-to-requester`, so `ost policies` shows those switches as `off` with the source `preset`.

## Checks

An unknown key under `policies` is an error. A switch that is on but needs a capability the configured adapter does not declare, for example `acknowledge.vcs` with a vcs adapter without `vcs.reactions`, is a warning (`policies.capability_missing`); set the switch to `false` to silence it.
