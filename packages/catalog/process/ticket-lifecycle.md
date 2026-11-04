# Ticket lifecycle

Every ticket in {{ team.name }} is in exactly one canonical status. Tracker-specific names map onto these seven.

| Status   | Meaning                             | What you do                                                                                                                                                                                           |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backlog  | Not yet refined or not scheduled    | Do not start it. Refine it only if it is assigned to you for refinement.                                                                                                                              |
| ready    | Clear, scoped, waiting for a person | Pick it up only when it is assigned to you and you have no active item.                                                                                                                               |
| active   | You are working on it               | Work on it. Keep one active item.                                                                                                                                                                     |
| review   | Waiting for someone else            | Answer review feedback; do not start new work on it.                                                                                                                                                  |
| blocked  | Cannot continue                     | Say in a comment what blocks it and who can unblock it: a decision or an answer from a human, or anything outside your control. Hand the item back as `blocked`, not `done` (`process/hand-back.md`). |
| done     | Finished and accepted               | Nothing. Never reopen it; file a new ticket for follow-ups.                                                                                                                                           |
| canceled | Will not be done                    | Nothing. Say why in a comment if you are the one canceling.                                                                                                                                           |

## Rules

- A comment on your ticket from a trusted human reaches you as feedback, also on a ticket you handed back. Read it, act on it and reply on the ticket.
- Work only on tickets assigned to you. Never work on a ticket assigned to someone else.
- When you change a status yourself and the reason is not obvious, say why in a comment: why it is blocked, why it is canceled.
- Do not set `done` unless your role is allowed to, or the ticket asked a question you answered conclusively (`process/hand-back.md`, "Questions and investigations"). Work you finish goes to `review`.
{{#if integrations.has.tracker}}
## Keeping the tracker in sync

The tracker is the shared record. The office keeps the routine changes for you, from what you do, and says on the ticket that it made them for you:

- you start a round on it (the work, review feedback, a comment, a rebase or failing checks), also on a ticket you handed back: it is assigned to you and moves to `active`, unless it is `done` or `canceled`;
- you open its pull request for review (not as a draft): it moves to `review`, and the pull request is linked on it right away;
- its last open pull request merges into the default branch and the checks on the merge commit pass (a deploy, say): it moves to `done` and stays assigned to you, who did the work. When one of them fails, it stays open and you are woken with the failed step's log: fix it on the same ticket, for example with a follow-up pull request;
- you hand back as `done` (only with a result to review or finished work): it moves to `review` and goes to the person who asked; as `waiting` (only for an answer you asked of another agent with `ost ask`): nothing changes; as `silent` (a round that needed nothing handed on): it goes back to how the round found it, undoing the move to `active` and the assignment to you of the round's start; as `blocked` (a decision or an answer from a human, or anything outside your control): it moves to `blocked` and goes to the team's PM to unblock, or to the person who asked when there is no PM or you are the PM. When the PM unblocks it, the PM assigns it back to you with the answer in a comment. A ticket you gave to someone else during the work stays with them: your hand-back does not undo that. A merge round's hand-back leaves the ticket as it is: nothing in it is left for the person who asked;
- the other tickets of the work that wait for review, the sub-tickets you created that are in review and the tickets whose pull requests you opened, go to `review` and to the person who asked with the same hand-back, whatever its status. Sub-tickets you filed for later stay as they are;
- a ticket with open sub-tickets (ready, active, in review or blocked; not ones in the backlog for later) stays `active` and yours when you hand it back as `done`, and its own pull request does not move it to `review` or `done`. When one of its sub-tickets closes and you have more of them open, you are woken on the parent with the ones still open. When its last sub-ticket closes, the parent moves to `done` if its own pull requests merged, else to `review` for the person who asked. A parent in `review` or `blocked` by then moves to `done` once nothing of its own is open (no open pull request), with a note listing its sub-tickets; one with an open pull request of its own goes to `review` for the person who asked.

Do not make these moves or assignments yourself, not even when your round starts: the ticket is already yours and `active` when you first look at it. The one exception is an answer that needs a human's review: move the ticket to review yourself, with the answer in a comment (`process/hand-back.md`, "Questions and investigations"). Hand back with the status that says where the work is (`process/hand-back.md`). Change a ticket yourself for what the office cannot see, the moment it happens: you cancel it, or you file, split or re-parent tickets. Comment with `ost ticket` on anything a reader would not see from the status.

- File what you find yourself with `ost ticket create`; do not ask someone else to. Work that is part of an existing ticket's scope is a subtask of it (`--parent <ticket>`, the default inside that ticket's work item, or `ost ticket parent <ticket> <parent>` for one that exists). A follow-up that stands on its own is a separate ticket with a relates link: `ost ticket create --related <ticket>`. It lands in the backlog, unassigned, unless you pass `--assignee` or `--status`. Name every ticket you filed in your hand-back.
- Tickets are related through the tracker, never through text in a description. The parent is the parent field: never write a "Part of" line. A dependency is a link: a ticket that can only start once another is done is blocked by it (`ost ticket create --blocked-by <ticket>`, or `ost ticket link <ticket> --blocked-by <other>` for one that exists; `--remove` undoes it). Never write "Depends on" in a description: the tracker cannot show it and the office cannot act on it. A blocked ticket moves to ready when its last blocker closes, and its agent is woken: for a sub-ticket whose parent you hold, on the parent.
- If the tracker and a work item disagree, trust the tracker, fix the work item, and mention it in the journal.
- When a decision changes what a ticket will do, edit its title and description (`ost ticket edit`) so they say what will be done; a comment alone leaves the ticket saying the old thing.
- One ticket per piece of work. Never file a ticket for work an existing ticket covers, not to get around something you cannot change, nor because the existing one waits on something unrelated: change that ticket (`ost ticket assign`, `move`, `edit`), or ask a human to. `ost ticket create` warns when an open ticket has a similar title; if it is the same work, cancel the new ticket with a comment that links the existing one, and if it is not, say on the new ticket why it is separate.

## Planning work for others

When you plan work that others will build (a design, an initiative, a re-plan), the plan comes before its tickets:

1. Write the breakdown into the plan: the pieces, their order, their dependencies and any stacks.
2. Share the plan for review: link it from the ticket and ask a trusted human to confirm it. List each open decision with its options and your recommendation.
3. Iterate on it: answer their comments and revise the plan. Comments on the document reach you as in `process/doc-feedback.md`, comments on the ticket as in "Rules" above.
4. File the tickets for its pieces only once a trusted human has confirmed the plan, or said it needs no confirmation. Until then, keep working: on the plan, on feedback and on other work. Hand back as `process/hand-back.md` says.
5. Then file the tickets from the confirmed breakdown, each linking the plan, with the dependencies of the breakdown as links (`--blocked-by`), not as text. When the plan changes later, edit or cancel the tickets it affects (`ost ticket edit`, or cancel with a comment that links the change).

Splitting your own ticket into sub-tickets for its pull requests is different: follow "One pull request per ticket" below.

## One pull request per ticket

{{#if policies.tickets.many_prs}}A ticket in {{ team.name }} may have several pull requests. The office moves it to `done` when its last open pull request merges into the default branch and the checks on the merge commit pass, so open every pull request the ticket needs before the first one merges, and list them in the hand-back. Prefer one pull request per ticket: when the parts can be reviewed on their own, split them into sub-tickets as below.
{{else}}The office moves a ticket to `done` when its last open pull request merges into the default branch and the checks on the merge commit pass (a merge into another pull request's branch, or while another pull request of the ticket is open, leaves it where it is), so in {{ team.name }} a ticket has one open pull request at a time. `ost pr open` refuses a pull request for a ticket that already has an open one, and says which one, or that is done or canceled. A merged one does not count while the ticket is open: a fix for a check that failed after the merge goes on the same ticket. A pull request a person opens for such a ticket is not refused; the last of them to merge closes the ticket.

Plan the split before you start. When the work needs more than one pull request (independent parts, a stack):

1. Create a sub-ticket for each extra part, assigned to yourself. The part you start now is `active`: `ost ticket create --parent <ticket> --assignee me --status active --title "..."`. Every later part is `ready`, never in the backlog where nothing picks it up: `--assignee me --status ready`. It is a subtask of the parent (a "relates" link where the tracker has no subtasks); its description says only what the part is, nothing about the parent. A part that can only start once another part has merged is blocked by it: add `--blocked-by <that sub-ticket>`. It starts blocked and moves to ready when its blocker closes.
2. Comment on the parent ticket that you split the work, with the links to the sub-tickets, what each one covers and their order: which one ships after which, and which go in parallel as a stack. You keep that order: when a sub-ticket closes, or you are idle with ready sub-tickets, you are woken on the parent with the open ones, and you pick the next from your plan.
3. Work them one pull request each. Reference that ticket in its pull request as the repository's conventions say (its key in the branch name or the title, or `Closes <ticket>` in the description if they say nothing), so the pull request is linked to the right ticket; a mention of a key alone links nothing. The parent's pull request covers what is left of the parent.
   {{/if}}{{else}}

## Without a tracker

- This team has no tracker. Work items are the record: the journal of each work item says what was done, what is open and where the links are.
- Use the same seven statuses in your journal entries so the state stays readable.
{{/if}}
