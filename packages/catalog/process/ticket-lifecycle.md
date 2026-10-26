# Ticket lifecycle

Every ticket in {{ team.name }} is in exactly one canonical status. Tracker-specific names map onto these seven.

| Status   | Meaning                             | What you do                                                                                                                                                               |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backlog  | Not yet refined or not scheduled    | Do not start it. Refine it only if it is assigned to you for refinement.                                                                                                  |
| ready    | Clear, scoped, waiting for a person | Pick it up only when it is assigned to you and you have no active item.                                                                                                   |
| active   | You are working on it               | Move it here when you start. Keep one active item.                                                                                                                        |
| review   | Waiting for someone else            | Move it here at hand-back. Answer review feedback; do not start new work on it.                                                                                           |
| blocked  | Cannot continue                     | Say what blocks it and who can unblock it, then ask that person with `ost ask`. Pick up other work. Hand the item back as `blocked`, not `done` (`process/hand-back.md`). |
| done     | Finished and accepted               | Nothing. Never reopen it; file a new ticket for follow-ups.                                                                                                               |
| canceled | Will not be done                    | Nothing. Say why in a comment if you are the one canceling.                                                                                                               |

## Rules

- A comment on your ticket from a trusted human reaches you as feedback. Read it, act on it and reply on the ticket. On a ticket you handed back it comes back to you as `active`.
- Move a ticket the moment its real state changes, not later in a batch.
- Assign the ticket to yourself before you start it. Never work on a ticket assigned to someone else.
- Comment on every status change that is not obvious: why it is blocked, why it is canceled.
- Do not set `done` unless your role is allowed to. Work you finish goes to `review`.
{{#if integrations.has.tracker}}
## Keeping the tracker in sync

- The tracker is the shared record. Keep the status, assignee and a short comment current with `ost ticket`.
- If the tracker and a work item disagree, trust the tracker, fix the work item, and mention it in the journal.

## One pull request per ticket

{{#if policies.tickets.many_prs}}A ticket in {{ team.name }} may have several pull requests. outstaff's automation moves it to `done` only when you have handed its work back as `done` and every pull request linked to it is closed with at least one merged; a merge alone does not close it. Hand back as `done` only once every pull request the ticket needs is open, and list them in the hand-back. Prefer one pull request per ticket: when the parts can be reviewed on their own, split them into sub-tickets as below.
{{else}}outstaff's automation moves a ticket to `done` the moment its pull request merges, so in {{ team.name }} a ticket is one pull request. `ost pr open` refuses a second pull request for a ticket that already has one, open or merged, and says which one. A pull request a person opens for such a ticket is not refused; the office comments on the ticket that it now has two, and the first to merge closes it.

Plan the split before you start. When the work needs more than one pull request (independent parts, a stack, a change after a merge):

1. Create a sub-ticket for each extra part: `ost ticket create --parent <ticket> --title "..."`. It is assigned to you and linked to the parent; its description starts with a "Part of" line with the parent's link.
2. Comment on the parent ticket that you split the work, with the links to the sub-tickets and what each one covers.
3. Work them one pull request each. Reference that ticket in its pull request as the repository's conventions say (its key in the branch name or the title, or `Closes <ticket>` in the description if they say nothing), so the pull request is linked to the right ticket; a mention of a key alone links nothing. The parent's pull request covers what is left of the parent.
   {{/if}}{{else}}

## Without a tracker

- This team has no tracker. Work items are the record: the journal of each work item says what was done, what is open and where the links are.
- Use the same seven statuses in your journal entries so the state stays readable.
{{/if}}
