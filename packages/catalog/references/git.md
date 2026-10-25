# Git

## Before you start

- Fetch before every work item. Branch from the up-to-date default branch{{#if repos.primary}} (`{{ repos.primary.default_branch }}` in `{{ repos.primary.name }}`){{/if}}.
- Work only in your item's worktree.

## Branches and commits

- New work gets one branch per item, named for the change, for example `feat/short-name`. Work on an open pull request of yours (review feedback, a conflict, a failing check, more work on its ticket) happens on that pull request's own branch, which your worktree already has checked out: push to it, and never create a second branch for the same pull request. Report the pull request, not the branch name.
- One commit per pull request. To change it, amend; do not add fixup commits.
- Commit summary: `type(scope): summary`, with `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. The pull request title is the same.
- The body says why, then links the ticket if there is one.

## Pushing

- Never push to the default branch. Open a pull request.
- Push an amended branch with `git push --force-with-lease`, and only on your own branch. Never force-push anyone else's branch or a shared one.

### A push GitHub rejects for a missing permission

A message such as "refusing to allow a GitHub App to create or update workflow" for a file under `.github/workflows/`, ending in "without `workflows` permission", means your App lacks the Workflows permission. Retrying, rewording or pushing another way does not help, and you cannot grant it yourself.

- Keep the commit on its branch. Do not drop or rewrite it.
- Hand back as **blocked**, not done: name the missing permission (here `workflows`), the file, and the branch that holds the commit. A person with admin rights on the GitHub App has to add it. See `process/hand-back.md`.
- Do not move the change into another file or path to get around the rejection.

## Stacked pull requests

Use a stack when a change depends on another that is not merged yet.

- Branch the second change from the first, and open its pull request against the first branch.
- When the bottom pull request merges, rebase bottom-up. For each branch, starting at the lowest:
  1. `git fetch`
  2. `git rebase --onto <default-branch> <old-parent-branch> <branch>`
  3. `git push --force-with-lease`
  4. Change the pull request base to the default branch (or the next branch below).
- Check each pull request after the rebase. Do not rebase a branch whose parent is still open.

## Conflicts

Resolve conflicts by rebasing onto the base, not by merging the base in. If the conflict changes the meaning of the work, say so in the pull request.
