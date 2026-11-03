---
title: "0025: Agents tell a human in chat when work lands on them"
description: A policy decides when a human is told that work waits for them; the office holds and merges the notices, and the agent's process sends them as a direct message from the agent's own chat account.
sidebar:
  order: 25
---

**Status:** accepted. Builds on [0019](/decisions/0019-agents-make-their-acts/) and [0022](/decisions/0022-act-echoes-wake-no-one/).

## Context

When an agent handed work to a human (a ticket in review, a blocked ticket a PM could not unblock, a pull request to review), the only signal was in the tracker or on the code host, and the human had to notice it there. Tickets sat in review or blocked with a human for a while before anyone looked. The office never posts to people, and an act is tracker or knowledge-base bookkeeping only.

## Decision

- **A policy decides, with a proposal of its own.** `notify_human_on_handoff` (on with `policies.notify_handoff`) proposes `notify`: who is told (a human, by an identity the team file gives them), by which agent, what is needed (`review` or `blocked`), the ticket, its pull requests and the agent's words. It is not an act op, so acts stay bookkeeping.
- **The office holds and merges notices.** A human's notices from one agent wait for `pipeline.notify.debounce_seconds` and while the agent's round on the ticket runs, then go as one message, one line per ticket. A pull request opened in a round goes with that round's hand-back.
- **The agent sends the message.** The office hands the merged message to the agent as an act with one `chat_dm` op; the agent's process (not a model run) opens the direct message with its own chat account and posts it. The office still never posts to people.
- **The agent's words are guarded**: the first two lines of the hand-back summary, without any mention that would notify someone.
- **No chat identity, no message**: the office logs it.

## Consequences

- The catalog no longer asks the agent to announce a hand-off in chat; the hand-back is enough.
- Work from a chat thread gets its result in the thread, so a hand-back of such work sends no direct message.
- An assignment a chat session made for the human it talks with ("assign it to me") sends none either: that human asked for it.
- A blocked hand-back on a team without a PM keeps the blocked agent's own report (`policies.hand_back.blocked_notify`).
- Code owners are not modelled: a pull request's message goes to the requester of its ticket.
