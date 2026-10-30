---
title: "0018: The event pipeline is the only way the office decides"
description: The workflow engine, its presets and rules, and the pipeline's off and shadow modes are gone; the pipeline decides on every event.
sidebar:
  order: 18
---

**Status:** accepted. Makes [0016](/decisions/0016-event-pipeline/) the office's only decision path and replaces the rules, presets and templates of [0011](/decisions/0011-configurable-workflow/); the status mapping of 0011 stays.

## Context

The office ran two decision paths: the workflow engine, with its presets, rules and the `policies` switches that rewrote them, and the event pipeline beside it, off, in shadow mode or live (`office.pipeline`). Shadow mode compared the two on every event and did its job: the differences it showed are known. Keeping both meant every behaviour had two implementations, the engine had side effects outside its rules, and chat had a routing path of its own.

## Decision

- **The pipeline decides on every event**, always. `office.pipeline` is gone, and with it shadow mode, the engine-vs-pipeline comparison (`ost explain --compare`, the office link's `compare` method and the `engine` and `comparison` fields of a trace) and the chat desk's routing. A chat message is a `chat.message` event like any other; the desk keeps the backend of the chat session's verbs and the reports.
- **The engine is gone:** its presets, rules, templates and the switches that only edited rules. `workflow.preset`, `workflow.rules`, `workflow.templates`, `policies.feedback.merged_prs`, `doc_comments`, `ticket_comments`, `mentions`, `policies.hand_back.reassign`, `policies.conflicts`, `policies.retry.on_signal` and `policies.tickets.start_moves_active` are removed keys: `ost validate` names what replaces each, usually `pipeline.policies.<id>.enabled: false`. The condition evaluator and the status mapping stay; the pipeline uses them.
- **No hidden side effects.** What the engine did outside its rules is a policy, the agent's own work, or gone:
  - moving a ticket to active when its work starts, and assigning an attached ticket back to the agent, are the agent's: a woken agent takes its ticket back and moves it to active itself, as its catalog instructions say;
  - retrying a blocked item on a human's signal is gone: the signal wakes the agent with a new round through the policies, and blocked items a later finished round made moot are closed;
  - joining queued or running work is the pipeline's: a wake joins an item of the same kind and subject (a chat message only a session that has not started), and coalescing folds close wakes;
  - follow-up rounds for feedback that came after an offer stay, as office bookkeeping that decides nothing;
  - hand-backs are the `hand_back_done` and `hand_back_blocked` policies.
- **The office acts only for agents.** Every tracker change is an `act` for the agent it serves. Today the office still makes it with its own tracker account and a note naming the agent, as 0016 recorded; making each act with the agent's own tracker identity, so the office's tracker account can be read-only, is the next step and needs a way to reach an agent's tracker credentials when no agent runs.

## Consequences

- One implementation of each behaviour, and every decision is traced. A gap is fixed in the pipeline, each as its own change: a blocked hand-back no longer wakes the PM to unblock it (the ticket goes to the requester), a mention no longer hands the ticket over by itself, and a pull request a human opens or merges leaves its ticket unmoved, since there is no agent to act for.
- The replay of acme events (`packages/office/src/pipeline/replay`) shows the pipeline's decisions only, against a golden file.
- Agents do more of their own ticket bookkeeping: taking the ticket back and moving it to active when they start.
- Not yet met: the office's tracker history still shows changes the office made for agents.
