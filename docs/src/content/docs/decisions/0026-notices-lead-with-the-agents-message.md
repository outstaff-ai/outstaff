---
title: "0026: A notice leads with the agent's message for the human, sent whole"
description: The agent hands back a short message for the human the work goes to; the notice leads with it, links the pull requests and then the ticket after it, and is never cut by the office.
sidebar:
  order: 26
---

**Status:** accepted. Replaces the guard of the agent's words in [0025](/decisions/0025-agents-tell-humans-work-landed/).

## Context

Every notice opened the same way ("Ready for your review: ACME-91 ..., pull request acme/app#70"), so the human could not tell from the first line what had changed. The words after it were the first two lines and 300 characters of the hand-back summary, which is also the journal entry: sometimes process narration ("I handed the item back as done"), sometimes a list of review points cut in the middle.

## Decision

- **The agent writes a message for the human.** `ost handback done --message "..."` hands back, beside the summary, what changed since the human last looked and what the agent needs from them. The catalog's hand-back guidance asks for it, short, and without process narration.
- **The notice leads with it.** The agent's message comes first, then what is needed (`Ready for your review`, `Blocked, needs you`) with the links: the pull requests first, since the human acts on them, with the head whose checks passed, then the ticket they are for; the ticket alone when there is no pull request, as for a blocked ticket. Without a message the notice uses the summary; a blocked ticket given without a hand-back uses the agent's latest comment on it, as before.
- **The office does not cut it.** It only takes out what would mention or notify someone. Keeping it short is the guidance's job.
- **Platform limits belong to the chat adapter.** A message longer than the platform takes is split into several messages, never cut.

## Consequences

- The same applies to a direct message and to a reply in the chat thread the ticket's work is tied to.
- An agent that gives no message still sends a useful notice, led by its summary, now whole.
