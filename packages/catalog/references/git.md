# Git

## Before you start

- Fetch before every work item. Branch from the up-to-date default branch{{#if repos.primary}} (`{{ repos.primary.default_branch }}` in `{{ repos.primary.name }}`){{/if}}.
- Work only in your item's worktree. For new work it starts on a detached HEAD at the default branch: outstaff names no branch for you. Create yours with `git switch -c <name>` before your first commit. An item that ends without code changes leaves no branch.

## The repository's conventions come first

The repository is the source of truth for how work is done in it. Before you change code, read what it states, and follow it for the number and format of commits, signing, branch names, the pull request title and body, the tests to run, and anything else it says.

- `CONTRIBUTING.md`, `AGENTS.md`, `.github/CONTRIBUTING.md`, `docs/CONTRIBUTING.md`.
- The pull request template, `.github/pull_request_template.md`. Use it for the description instead of `templates/pull-request.md`.
- Commit rules that CI enforces: a commit message linter, a single-commit check, a sign-off check.
- Any extra files the team lists for the repository.
{{#if repos.has_conventions}}

The team also states these conventions, which apply in addition to the repository's files:
{{#each repos.list}}
{{#if this.conventions}}

`{{this.name}}`:

{{this.conventions}}
{{/if}}
{{/each}}
{{/if}}

The work prompt lists the convention files found in your worktree. A project `CLAUDE.md` is not one of them unless the team lists it: it is often written for a person's own assistant sessions.

If the repository says nothing on a point, use these defaults:

- One branch per item, created by you once you know the work, before the first commit. Name it `<type>/<ticket key>-<short slug>`, for example `feat/ACME-106-di-scopes`, or `<type>/<short slug>` without a ticket. The office links a pull request to its ticket from the key in the branch name, in the title, or after a closing keyword in the description (`Closes ACME-12`). Follow the repository's conventions for how to reference the ticket, and make sure one of these carries the key; a key mentioned anywhere else links nothing. If the repository says nothing, put `Closes <ticket key>` in the description.
- Focused commits with clear messages, in the style of the repository's recent history.
- A pull request description that says why, then references the ticket if there is one, as above.
- Never rewrite a commit you did not make, and never touch anyone else's branch.

When the repository's rules and a default disagree, the repository wins. When two of its rules disagree, or a rule would make you do something unsafe, say so in the pull request or ask with `ost ask`.

## Pushing

These are outstaff's mechanics, whatever the conventions say.

- Never push to the default branch. Open a pull request.
- New work gets one branch per item, the one you create. Work on an open pull request of yours (review feedback, a conflict, a failing check, more work on its ticket) happens on that pull request's own branch, which your worktree already has checked out: push to it, and never create a second branch for the same pull request. Report the pull request, not the branch name.
- Push to your own branch only, and to the head branch of the pull request you work on. Never push to anyone else's branch or a shared one.
- After you rewrite commits that are already pushed (an amend, a rebase), push with `git push --force-with-lease`. Never force-push anyone else's branch or a shared one.

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

Resolve conflicts the way the repository's conventions say. If they say nothing, rebase onto the base rather than merging the base in. If the conflict changes the meaning of the work, say so in the pull request.
