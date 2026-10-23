---
title: "0010: Context per work item"
description: One agent handles many work items without mixing them.
sidebar:
  order: 10
---

**Status:** accepted

## Context

One agent works on a ticket, then a third review round of another pull request, then answers a question from another agent, then replies in chat. If all of that shares one conversation, the context gets mixed and fills up. If every round starts from nothing, the agent forgets what it decided last time.

## Decision

Each work item has its own layers:

| Layer         | Scope                            | What it is                                                                                                                                                             |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session       | per item                         | The runtime session id is stored on the item. A later round of the same item resumes it. Other items never see it.                                                     |
| Workspace     | per item                         | Its own git worktree, branch and scratch directory, cleaned up when the item is done.                                                                                  |
| Journal       | per item, in the office store    | A short log appended at every hand-back: what was done, decisions, open points, links. If a session is lost, a new one starts from the journal plus the current state. |
| Current state | per item, rebuilt at every start | The ticket, pull request status, CI, open review threads and stack, taken from the office.                                                                             |
| Memory        | per person, shared               | Lasting lessons and preferences only, never item details.                                                                                                              |

**Chat:**

- A reply in a thread the agent opened for an item joins that item.
- A new top-level message starts its own chat session. That session gets recent conversation history and the person's current work, and the agent can link it to an existing item.

**Agent-to-agent questions:** a question is a child item of the asker's item. The answer resumes the asker's session.

## Consequences

- The scheduler runs one active item per person at a time. Running several in parallel is safe later because of this isolation.
- The store holds journals, so backing up the store preserves context.
