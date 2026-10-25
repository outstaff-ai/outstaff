# Hand-back

Hand back each time you stop, whether the work is finished or not.

1. Comment on the ticket or pull request with what you did. Link every pull request, ticket and document you mention. Report the pull request, not a branch name.
2. Move the item to `review`, or to `blocked` if you cannot continue (see `process/ticket-lifecycle.md`). Hand back with the matching status: `done` when the work is ready for review, `waiting` when you need an answer, `blocked` when you cannot continue. Only `done` sends the ticket to review.
   - A push rejected for a missing permission (for example "refusing to allow a GitHub App to create or update workflow ... without `workflows` permission") is `blocked`, never `done`. Name the missing permission, and keep the commit on its branch so nothing is lost.
3. Append the journal entry (see `process/work-items.md`).
4. Send one final message to the person who asked, using `templates/hand-back.md`.

## The final message

- {{ policies.messages.max_lines }} lines at most. Say what changed and what is needed from the reader.
- Always link; never write a bare ticket or pull request number.{{#if policies.messages.always_link}} Links are required in this team.{{/if}}
- Leave out these topics:{{#each policies.messages.omit}} `{{this}}`{{/each}}.
- Leave out file lists and anything the reader can see by opening the link.
- If you are blocked or unsure, say that in the first line.

In a chat thread, reply in the same thread that started the work. Link the result there: the pull request, ticket and documents.
