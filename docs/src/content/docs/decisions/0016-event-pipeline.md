---
title: "0016: One event pipeline with three decisions"
description: Every event goes through ordered policies that decide to wake an agent, act for an agent, or drop it, and every decision is traced.
sidebar:
  order: 16
---

**Status:** accepted. Replaces the rule engine of [0011](/decisions/0011-configurable-workflow/); the status mapping stays. Since [0018](/decisions/0018-pipeline-only/) the pipeline is the only way the office decides, and the off and shadow modes below are gone. Since [0019](/decisions/0019-agents-make-their-acts/) the agent an act is for makes it, as itself. [0021](/decisions/0021-merging-is-the-agents-decision/) replaces its merge decision: merging is the agent's decision, woken when its pull request may be ready.

## Context

Live use of a team showed most office bugs in one place, the rule engine (`packages/office/src/engine`): a ticket closed by a merge into a stack's branch, a conflict ignored because the pull request already conflicted, blocked work moved to review, an agent left idle with ready tickets. The engine changes the tracker without saying for whom, has side effects outside its rules (moving a ticket to active when work starts, assigning an attached ticket back), routes chat through a separate path, and skips events an agent caused itself, which strands work that agent assigned itself. When it does something unexpected, nothing records why.

Intake, the work state, the store and the scheduler work well and stay.

## Decision

- **One stream of events**, chat included: `chat.message`; `pr.opened`, `pr.review_submitted`, `pr.comment`, `pr.merged`, `pr.closed`; `pr.conflicted`, `pr.ci_failed`, `pr.behind_base` and `pr.base_merged`, derived when any merge changes the base under another open pull request of the repository, whoever authored or merged either, each naming the merge that caused it; `ticket.commented`, `ticket.assigned`, `ticket.moved`, `ticket.created`; `doc.commented`; `agent.handed_back` and `agent.idle`.
- **Three decisions, nothing else:**
  - `wake {person, kind, instruction, feedback, subject}` schedules a run. The instruction is a template that says what is expected; the agent decides how, following the repository's conventions.
  - `act {as, ops}` makes a tracker or knowledge change (move, assign, comment, set parent) on behalf of the agent `as` names, without a model run. The office makes it with its own account and posts a comment saying whom it was for; the trace records `as` and the result. With no agent to act for, it is dropped.
  - `drop {reason}`.
- **Policies** are `{id, on, when, decide}`. `when` uses the workflow rules' conditions, plus pipeline conditions such as `actor_is: assignee`. Every policy is evaluated, in order, and every match contributes. A default set ships; `pipeline.policies.<id>` turns one off, replaces its instruction or narrows it.
- **Wakes coalesce** per person and subject within `pipeline.wake.coalesce_seconds` (default 60): a batch of review comments becomes one run.
- **Every event is traced**: each policy, matched or not, the first condition that failed, and the decisions. `ost explain <event-id>` prints a trace.

The default set:

| Event                                                                 | Decision                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `chat.message` from a human                                           | wake the agent it was written to (`chat`)                             |
| a human's review or comment on an agent's pull request                | wake the author (`review_feedback`, or `merged_feedback` once merged) |
| `pr.merged` into the default branch, no other pull request of it open | act for the author: ticket to done                                    |
| `pr.conflicted`, `pr.behind_base`, `pr.base_merged` on an agent's PR  | wake the author (`rebase`), naming the merge that caused it           |
| `pr.ci_failed` on an agent's pull request                             | wake the author (`ci_failed`)                                         |
| `pr.opened`, not a draft                                              | act for the author: ticket to review                                  |
| `ticket.assigned` or `ticket.created` to an agent, by anyone but it   | wake the assignee (`assigned`)                                        |
| `ticket.commented` by a human                                         | wake the agent mentioned, else the assignee                           |
| `ticket.moved` to active by a human                                   | wake the assignee                                                     |
| `doc.commented` by a human                                            | wake the agent mentioned, else the document's author                  |
| `agent.handed_back` as done, or as blocked                            | act for the agent: the status move and the hand-back to the requester |
| `agent.idle`                                                          | wake the agent with its next ready ticket: by priority, then age      |

Branch and merge practice (one pull request per ticket, stacking, merge method) is left to each repository's own rules and instructions.

## Consequences

- Ticket history shows the office's account for the changes it makes, each with a comment naming the agent it acted for.
- What the engine did outside its rules becomes explicit policies or goes. Some of today's behaviour is not in the default set yet (the PM's unblock round, a mention handing a ticket over, taking a ticket back by moving it to active); the replay report lists each one.
- Chat stops being a separate path; the chat desk keeps filing and attaching only.

## Recorded decisions

These were decided while reviewing the proof of concept.

- **The office acts as itself.** An `act` is made with the office's own tracker account, on behalf of the agent it names, with a comment saying so. One narrowly scoped account is simpler than giving every agent's credentials to a process that makes changes for it, nothing has to be distributed or kept in step, and it works when agents run nowhere between items (cloud agents that scale to zero). Making changes with each agent's identity, from a daemon in the agent's pod or through a credential broker, stays possible later behind the same executor interface.
- **The office's write scope is tracker coordination metadata only:** a ticket's status, assignment, labels, parent link and comments that say whom a change was for. On the code host the office is strictly read-only: it writes no labels, comments or anything else there. Status lives in the tracker, and the office never messages people.
- **The office never merges.** An agent marking a pull request ready enables the platform's auto-merge or merge queue, in the same run and with its own identity (`policies.merge.on_approval` now means agents may do so); the repository's rules decide when it merges, with the repository's merge method, and the office only observes `pr.merged`. An approval wakes nobody to merge: the approval-triggered merge wake is gone, so no model run is spent on an administrative step. On GitHub merge permission comes with `contents: write`, which also allows pushing to any branch, so no office identity ever holds it and the office App stays read-only. A cancelled auto-merge (new commits, a conflict, failing CI) reaches the author through the conflict and CI policies.

## Status of the proof of concept

The first part lives beside the engine in `packages/office/src/pipeline` and changes nothing the office does:

- the event, decision, policy and trace types, policy evaluation with traces, the default set, coalescing, merge-derived events, the idle pick, and a trace store in the office store;
- **shadow mode**: with `office.pipeline: shadow` every event also runs through the pipeline, before the engine applies anything, and only its trace is recorded, for `ost explain`;
- a replay of about fifty acme events through the engine's rules and the pipeline, side by side, with a note on every difference (`packages/office/src/pipeline/replay/__tests__/__golden__/acme-replay.md`).

The second part adds, still off by default:

- **acts made by the office**: the office carries out each act with its own tracker and knowledge ports, posts the act's note (a policy template naming the agent it was for), and records the result on the event's trace, once per act;
- **live mode**: with `office.pipeline: live` the pipeline judges intake, work state and hand-back events instead of the engine's rules, queues its wakes (with the instruction in the item's journal) and makes its acts. The engine's item hooks (moving a ticket to active when work starts, follow-up rounds, unblock routing) still run;
- **an office link**: with `link.url` and `OUTSTAFF_LINK_TOKEN` the office connects out over a WebSocket to a monitoring or management service, a dashboard for example. The service keeps no office data: it asks the office for people, events, one event or one work item, and the office tells it when people, traces or items change. An office that is offline shows nothing. See the [office link protocol](/reference/office-link/). A wake records the work item it queued, and a queued item records the policy and event behind it.

A third part makes shadow mode measurable: each shadow trace also records what the engine applied for the same event and how the two compare (the same comparison the replay uses), `ost explain --compare` sums that up over a period, and the office link answers the same summary (`compare`) and filters the events that differ.

A fourth part raises `agent.idle`: the work state records when each ticket entered its status and the tracker's priority, and the office raises the event for an agent with nothing queued or running and a ready ticket to start (when a ticket change gives it a ready ticket, after a hand-back, on the scheduler's tick, when the agent connects). With the pipeline off the scheduler pulls the ticket itself (`policies.pull_ready`); in shadow mode the decision is traced first; live, the `idle_pulls_next` policy decides it.

A fifth part makes chat an event and coalesces wakes. A chat message an agent passes on is recorded by intake as `chat.message` (source `chat`) and judged by the pipeline: with the pipeline off the chat desk routes it as before; in shadow mode the desk still routes it and the trace compares what the desk did with the `chat_to_addressed` wake; live, the pipeline's wake queues a chat session in place of the desk's routing, and the desk keeps the filing and attach verbs and the queued reports. Live wakes coalesce in the scheduler's enqueue: the run the first wake for a person and subject queues is held until `pipeline.wake.coalesce_seconds` after its event, and later wakes inside the window are folded into it, each trace naming the item and its events.

Not yet: reading whether the code host requires up-to-date branches (#348), wiring the merge-derived events into the work state, and the policies that would replace the engine's item hooks and the chat desk's placement answers. Shadow and live mode see the work state's own `pr.conflicted` and `pr.ci_failed` only.
