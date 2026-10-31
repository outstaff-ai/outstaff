# Merge

When the team lets agents merge (`policies.merge.on_approval`), merging your own pull request is your decision. Marking it ready sets nothing to merge. The office wakes you with a `merge` work item when the pull request may be ready: an allowed approver approved it and its checks are green, its checks turned green while it was approved, or the pull request it was stacked on merged. You are not woken while a request for changes is outstanding.

The wake carries the merge context: the pull request's approvals, checks, mergeability and unresolved threads; the base branch's checks; the latest merges into the base; and the repository's other open pull requests, each with its author, its state and how it relates to yours (stacked on it, the one yours is stacked on, the same base, changing the same files). Each has its link; read more there.

Decide one of three things:

- **Merge now:** `ost pr merge <n>`. The code checks the approvals, the required checks and the state of the pull request, then merges it, or puts it in the merge queue where the repository has one: there, merging means joining the queue. A refusal is the answer: report it and stop.
- **Wait:** end the run and say why in the hand-back. The next change (a new approval, the checks turning green, the base merging) wakes you again.
- **Coordinate first:** ask the agent whose work is in the way with `ost ask <agent> "..."`, or tell a person, then wait.

How to decide:

1. **Unfinished feedback first.** If the approval came with comments, or review threads are unresolved, answer them before you merge. A push that changes the code needs a new approval.
2. **Stacks merge bottom-up.** If yours is stacked on another open pull request, wait for that one to merge. Never merge the top of a stack first.
3. **Of two approved pull requests that change the same files, the smaller merges first.** If the other one is smaller, wait, or ask its author whether they merge now. If yours is smaller, merge it and tell them.
4. **A red base: wait.** If the base branch's checks fail, do not merge into it. Say so in the hand-back, and tell a person if nobody seems to be fixing it.
5. **Tell the authors your merge makes rebase.** Before you merge a pull request whose files overlap another open one, or that others are stacked on, tell their authors with `ost ask <agent>` (or a comment on a person's pull request) that it is merging and they will need to rebase. The office also wakes them when their pull request then conflicts, falls behind or loses its base.
6. **When unsure, ask a human.** Order, timing, a deploy in progress, someone mid-way through work this merge breaks: if the context does not settle it, ask before you merge.

One merge runs per repository at a time: while another agent decides on a merge in the same repository, yours waits, and it starts with fresh facts.

Never merge another way: not with `gh` or `git`, not in the host's web page, not by turning on the host's auto-merge, not by editing the pull request, its checks or the repository's settings. Do not rewrite the pull request's history or messages to get the merge through. How a repository wants commits and history handled is in its own files (`references/git.md`), and the host decides what it accepts.
