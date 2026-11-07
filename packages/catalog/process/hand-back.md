# Hand-back

Hand back each time you stop, whether the work is finished or not.

1. Comment on the ticket or pull request with what you did. Link every pull request, ticket and document you mention. Report the pull request, not a branch name. If you split the ticket, link the sub-tickets and their pull requests too. A round woken by a comment that had nothing for you skips this step and step 4, and hands back `silent` (`process/work-items.md`, "Comments on documents and tickets").
2. Hand back with the status that says where the work is, with `ost handback <status>` before you end the round.{{#if policies.notify_handoff}} With `done`, add your message for the human the work goes to: `ost handback done --message "<text>"` (see "The message for the human" below).{{/if}}
   - `done`: only when there is a result to review or the work is finished: a pull request open for review, a document linked to the ticket, the ticket closed, or the ticket moved to review by you with your answer in a comment (see "Questions and investigations" below). A round that leaves none of these is not `done`, whatever the work: you are told so once, and then it is handed back as `blocked`.
   - `blocked`: you wait on a decision or an answer from a human, or on anything outside your control. Waiting on a human's review of a pull request that is open for them, or on a sub-ticket someone else holds, is not blocked: that is `silent`. Nor is a ticket in the backlog: it is planned for later, not stuck. A round on it (a comment or a mention) answers or updates the ticket and hands back `silent`, or with the answer; the office takes a `blocked` on it as `silent`. Say in the comment what you need and from whom, and add a message for the human that leads with it: `ost handback blocked --message "ACME-98 needs one of these from you: ..."`. Name the ticket and the decision, answer or access needed; never "I am blocked". A push or pull request refused for a missing permission (for example "refusing to allow a GitHub App to create or update workflow ... without `workflows` permission") is `blocked`, never `done`: say in the comment the exact permission a human must grant, and where (for example "Workflows: Read and write, on this agent's GitHub App"), and keep the commit on its branch so nothing is lost.
   - `waiting`: only for an answer you already asked of another agent with `ost ask`. You do not say it; asking is enough.
   - `silent`: the round needed nothing handed on, for example a comment or a mention that asks nothing of you, or a merge that has to wait. Rounds of comments, mentions, questions, chat, reviews, merges and pull request upkeep with no result finish silently when you say nothing. Work on a ticket finishes silently only when you wait on work in flight: its pull requests open for a human's review, its sub-tickets in review or with an agent. Hand back `silent` then, and send no message: the human already has the review. The office checks it: it takes a `silent` on a ticket that waits on nothing as `blocked`, and a `blocked` on a ticket that only waits on work in flight as `silent`, with no PM woken and nobody told again.

   The office moves the ticket from that status for you, and gives it on: `done` to review and to the person who asked; `blocked` to blocked and to the team's PM, who tries to unblock it before a human is asked (to the person who asked when the team has no PM, or you are the PM); `waiting` changes nothing; `silent` leaves the ticket as it was before the round. A ticket you gave to someone else during the work stays with them: the hand-back does not move or reassign it. Do not make that move or assignment yourself. A `done` hand-back on a ticket that is blocked is treated as blocked, so never hand back as `done` while the ticket is blocked.

3. Append the journal entry (see `process/work-items.md`).
4. Write your hand-back summary as one final message to the person who asked, using `templates/hand-back.md`. Do not post it in chat yourself: in a chat thread your agent posts it there{{#if policies.notify_handoff}}, and when the hand-back gives the work to a human, your agent sends them your `--message` in chat (your final message when you gave none), with the ticket and pull request links after it{{/if}}.

## Questions and investigations

A ticket that asks a question, or asks you to find something out, ends in one of three ways:

- **A conclusive answer:** comment the answer on the ticket, close it (`ost ticket move <key> done`) and hand back as `done`.
- **A follow-up:** the answer shows more work to do on the ticket. Leave it active (or move it back to `active`) and go on with the work; this is not a hand-back.
- **An answer that needs a human's review:** comment the answer on the ticket, move the ticket to review yourself (`ost ticket move <key> review`) and hand back as `done`.

An answer you only wrote in your final message, with the ticket left as it was, is none of these: there is nothing to review.
{{#if policies.notify_handoff}}

## The message for the human

The human reads it first, before any link, to know what happened since they last looked.

- Say what changed and what you need from them: a review, a decision, or nothing. For example: "Addressed the review on acme/app#70: own preview step and top-level env; answered the question about caching without a change."
- Leave out how you worked. "I handed the item back as done", "I pushed and checked formatting" or "I ran the tests" tell them nothing.
- For `blocked`, lead with the ticket and what is needed from whom, for example "ACME-98 needs one of these from you: the staging key, or a go-ahead to mock the payment service."
- Keep it short, a line or two. It is sent whole, never cut.
- The ticket and pull request are linked after it; link anything else you mention.
{{/if}}

## The final message

- {{ policies.messages.max_lines }} lines at most. Say what changed and what is needed from the reader.
- Always link; never write a bare ticket or pull request number.{{#if policies.messages.always_link}} Links are required in this team.{{/if}}
- Leave out these topics:{{#each policies.messages.omit}} `{{this}}`{{/each}}.
- Leave out file lists and anything the reader can see by opening the link.
- If you are blocked or unsure, say that in the first line.

In a chat thread, reply in the same thread that started the work. Link the result there: the pull request, ticket and documents.
