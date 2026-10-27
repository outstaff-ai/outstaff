---
title: "0016: One event pipeline with three decisions"
description: Every event goes through ordered policies that decide to wake an agent, act as an agent, or drop it, and every decision is traced.
sidebar:
  order: 16
---

**Status:** proposed. Would replace the rule engine of [0011](/decisions/0011-configurable-workflow/); the status mapping stays.

## Context

Live use of a team showed most office bugs in one place, the rule engine (`packages/office/src/engine`): a ticket closed by a merge into a stack's branch, a conflict ignored because the pull request already conflicted, blocked work moved to review, an agent left idle with ready tickets. The engine changes the tracker as the office's own account, has side effects outside its rules (moving a ticket to active when work starts, assigning an attached ticket back), routes chat through a separate path, and skips events an agent caused itself, which strands work that agent assigned itself. When it does something unexpected, nothing records why.

Intake, the work state, the store and the scheduler work well and stay.

## Decision

- **One stream of events**, chat included: `chat.message`; `pr.opened`, `pr.review_submitted`, `pr.comment`, `pr.merged`, `pr.closed`; `pr.conflicted`, `pr.ci_failed`, `pr.behind_base` and `pr.base_merged`, derived when any merge changes the base under another open pull request of the repository, whoever authored or merged either, each naming the merge that caused it; `ticket.commented`, `ticket.assigned`, `ticket.moved`, `ticket.created`; `doc.commented`; `agent.handed_back` and `agent.idle`.
- **Three decisions, nothing else:**
  - `wake {person, kind, instruction, feedback, subject}` schedules a run. The instruction is a template that says what is expected; the agent decides how, following the repository's conventions.
  - `act {as, op}` makes a tracker or knowledge change (move, assign, comment, set parent) as that agent, with its own identity and without a model run. With no agent to act as, it is dropped: the office never acts as itself.
  - `drop {reason}`.
- **Policies** are `{id, on, when, decide}`. `when` uses the workflow rules' conditions, plus pipeline conditions such as `actor_is: assignee`. Every policy is evaluated, in order, and every match contributes. A default set ships; `pipeline.policies.<id>` turns one off, replaces its instruction or narrows it.
- **Wakes coalesce** per person and subject within `pipeline.wake.coalesce_seconds` (default 60): a batch of review comments becomes one run.
- **Every event is traced**: each policy, matched or not, the first condition that failed, and the decisions. `ost explain <event-id>` prints a trace.

The default set:

| Event                                                                  | Decision                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `chat.message` from a human                                            | wake the agent it was written to (`chat`)                             |
| a human's review or comment on an agent's pull request                 | wake the author (`review_feedback`, or `merged_feedback` once merged) |
| an allowed approver's bare approval, with `policies.merge.on_approval` | wake the author to merge                                              |
| `pr.merged` into the default branch, no other pull request of it open  | act as the author: ticket to done                                     |
| `pr.conflicted`, `pr.behind_base`, `pr.base_merged` on an agent's PR   | wake the author (`rebase`), naming the merge that caused it           |
| `pr.ci_failed` on an agent's pull request                              | wake the author (`ci_failed`)                                         |
| `pr.opened`, not a draft                                               | act as the author: ticket to review                                   |
| `ticket.assigned` or `ticket.created` to an agent, by anyone but it    | wake the assignee (`assigned`)                                        |
| `ticket.commented` by a human                                          | wake the agent mentioned, else the assignee                           |
| `ticket.moved` to active by a human                                    | wake the assignee                                                     |
| `doc.commented` by a human                                             | wake the agent mentioned, else the document's author                  |
| `agent.handed_back` as done, or as blocked                             | act as the agent: the status move and the hand-back to the requester  |
| `agent.idle`                                                           | wake the agent with its ready ticket that entered ready first         |

Branch and merge practice (one pull request per ticket, stacking, merge method) is left to each repository's own rules and instructions.

## Consequences

- Ticket history shows only humans and agents. The executor of `act` (the agent's process, or the office holding each agent's key) is a separate choice; the decision is the same either way.
- What the engine did outside its rules becomes explicit policies or goes. Some of today's behaviour is not in the default set yet (the PM's unblock round, a mention handing a ticket over, taking a ticket back by moving it to active); the replay report lists each one.
- Chat stops being a separate path; the chat desk keeps filing and attaching only.

## Status of the proof of concept

The first part lives beside the engine in `packages/office/src/pipeline` and changes nothing the office does:

- the event, decision, policy and trace types, policy evaluation with traces, the default set, coalescing, merge-derived events, the idle pick, and a trace store in the office store;
- **shadow mode**: with `office.pipeline: shadow` every event also runs through the pipeline, before the engine applies anything, and only its trace is recorded, for `ost explain`;
- a replay of about fifty acme events through the engine's rules and the pipeline, side by side, with a note on every difference (`packages/office/src/pipeline/replay/__tests__/__golden__/acme-replay.md`).

Not yet: the `act` path to the agent, chat as an event, raising `agent.idle` and knowing when a ticket entered ready (#349), reading whether the code host requires up-to-date branches (#348), and wiring the merge-derived events and coalescing into the work state and scheduler. Shadow mode traces the work state's own `pr.conflicted` and `pr.ci_failed` only.
