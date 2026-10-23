# Work items

A work item is one unit of work scheduled for you: a ticket, a new review round on a pull request, a merge conflict, failing CI, a question from another agent, or a chat request. Each item has its own session, worktree and journal.

## Rules

- Work on one item at a time, the one you were started on. Finish it or hand it back before looking at another.
- Never mix items. Do not carry code, branches, decisions or assumptions from one item into another. Anything that applies to later items goes in memory (see `references/memory.md`).
- Start from the current state the office gives you (ticket, pull request, CI, open review threads), not from what you remember.
- Stay inside the item. If you find unrelated work, file or mention it; do not do it now.
- Use `ost work list` to see your current item and your queue.

## Journal

Append to the journal every time you hand back, whatever the outcome:

- what you did and why;
- decisions you made and the alternatives you dropped;
- what is still open, and who you are waiting for;
- links to the pull request, ticket and documents.

Keep it short. A new session must be able to continue from the journal plus the current state.

## Hand-back

An item is not finished until you have followed `process/hand-back.md`. If you are blocked, write that in the journal and say who can unblock you.
