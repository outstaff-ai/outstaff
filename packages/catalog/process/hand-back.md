# Hand-back

Hand back each time you stop, whether the work is finished or not.

1. Comment on the ticket or pull request with what you did. Link every pull request, ticket and document you mention. Report the pull request, not a branch name. If you split the ticket, link the sub-tickets and their pull requests too.
2. Hand back with the status that says where the work is, with `ost handback <status>` before you end the round:
   - `done`: only when there is a result to review or the work is finished: a pull request open for review, a document linked to the ticket, the ticket closed, or the ticket moved to review by you with your answer in a comment (see "Questions and investigations" below). A round that leaves none of these is not `done`, whatever the work: you are told so once, and then it is handed back as `blocked`.
   - `blocked`: you wait on a decision or an answer from a human, or on anything outside your control. Say in the comment what you need and from whom. A push or pull request refused for a missing permission (for example "refusing to allow a GitHub App to create or update workflow ... without `workflows` permission") is `blocked`, never `done`: say in the comment the exact permission a human must grant, and where (for example "Workflows: Read and write, on this agent's GitHub App"), and keep the commit on its branch so nothing is lost.
   - `waiting`: only for an answer you already asked of another agent with `ost ask`. You do not say it; asking is enough.
   - `silent`: the round needed nothing handed on, for example a comment or a mention that asks nothing of you, or a merge that has to wait. Only rounds of comments, mentions, questions, chat, reviews, merges and pull request upkeep may finish silently; work on a ticket never does. A round of those kinds with no result finishes silently when you say nothing.

   The office moves the ticket from that status for you, and gives it on: `done` to review and to the person who asked; `blocked` to blocked and to the team's PM, who tries to unblock it before a human is asked (to the person who asked when the team has no PM, or you are the PM); `waiting` changes nothing; `silent` leaves the ticket as it was before the round. A ticket you gave to someone else during the work stays with them: the hand-back does not move or reassign it. Do not make that move or assignment yourself. A `done` hand-back on a ticket that is blocked is treated as blocked, so never hand back as `done` while the ticket is blocked.

3. Append the journal entry (see `process/work-items.md`).
4. Send one final message to the person who asked, using `templates/hand-back.md`.

## Questions and investigations

A ticket that asks a question, or asks you to find something out, ends in one of three ways:

- **A conclusive answer:** comment the answer on the ticket, close it (`ost ticket move <key> done`) and hand back as `done`.
- **A follow-up:** the answer shows more work to do on the ticket. Leave it active (or move it back to `active`) and go on with the work; this is not a hand-back.
- **An answer that needs a human's review:** comment the answer on the ticket, move the ticket to review yourself (`ost ticket move <key> review`) and hand back as `done`.

An answer you only wrote in your final message, with the ticket left as it was, is none of these: there is nothing to review.

## The final message

- {{ policies.messages.max_lines }} lines at most. Say what changed and what is needed from the reader.
- Always link; never write a bare ticket or pull request number.{{#if policies.messages.always_link}} Links are required in this team.{{/if}}
- Leave out these topics:{{#each policies.messages.omit}} `{{this}}`{{/each}}.
- Leave out file lists and anything the reader can see by opening the link.
- If you are blocked or unsure, say that in the first line.

In a chat thread, reply in the same thread that started the work. Link the result there: the pull request, ticket and documents.
