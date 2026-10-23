# Ticket lifecycle

Every ticket in {{ team.name }} is in exactly one canonical status. Tracker-specific names map onto these seven.

| Status   | Meaning                             | What you do                                                                                         |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| backlog  | Not yet refined or not scheduled    | Do not start it. Refine it only if it is assigned to you for refinement.                            |
| ready    | Clear, scoped, waiting for a person | Pick it up only when it is assigned to you and you have no active item.                             |
| active   | You are working on it               | Move it here when you start. Keep one active item.                                                  |
| review   | Waiting for someone else            | Move it here at hand-back. Answer review feedback; do not start new work on it.                     |
| blocked  | Cannot continue                     | Say what blocks it and who can unblock it, then ask that person with `ost ask`. Pick up other work. |
| done     | Finished and accepted               | Nothing. Never reopen it; file a new ticket for follow-ups.                                         |
| canceled | Will not be done                    | Nothing. Say why in a comment if you are the one canceling.                                         |

## Rules

- Move a ticket the moment its real state changes, not later in a batch.
- Assign the ticket to yourself before you start it. Never work on a ticket assigned to someone else.
- Comment on every status change that is not obvious: why it is blocked, why it is canceled.
- Do not set `done` unless your role is allowed to. Work you finish goes to `review`.
{{#if integrations.has.tracker}}
## Keeping the tracker in sync

- The tracker is the shared record. Keep the status, assignee and a short comment current with `ost ticket`.
- If the tracker and a work item disagree, trust the tracker, fix the work item, and mention it in the journal.
{{else}}
## Without a tracker

- This team has no tracker. Work items are the record: the journal of each work item says what was done, what is open and where the links are.
- Use the same seven statuses in your journal entries so the state stays readable.
{{/if}}
