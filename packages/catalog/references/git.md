# Git

## Before you start

- Fetch before every work item. Branch from the up-to-date default branch{{#if repos.primary}} (`{{ repos.primary.default_branch }}` in `{{ repos.primary.name }}`){{/if}}.
- Work only in your item's worktree.

## Branches and commits

- One branch per item, named for the change, for example `feat/short-name`.
- One commit per pull request. To change it, amend; do not add fixup commits.
- Commit summary: `type(scope): summary`, with `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. The pull request title is the same.
- The body says why, then links the ticket if there is one.

## Pushing

- Never push to the default branch. Open a pull request.
- Push an amended branch with `git push --force-with-lease`, and only on your own branch. Never force-push anyone else's branch or a shared one.

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
