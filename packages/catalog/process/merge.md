# Merge

Merging is the code host's job, not yours and not the office's. When the team lets agents merge (`policies.merge.on_approval`), marking your pull request ready sets it to merge: `ost pr update <n> --ready` (or `ost pr open` without `--draft`) also turns on the host's auto-merge, or adds the pull request to the merge queue where the repository has one. The repository's own rules (required approvals and checks) decide when it merges, with the repository's merge method. You are not woken for the merge; the ticket moves when it merges.

1. Mark a pull request ready only when it is ready to merge as it is: once a person approves it and the checks pass, it merges without you.
2. Report what the verb said in the journal: auto-merge on, added to the merge queue, or not turned on and why. If it was not turned on, a person merges it; say so in the hand-back.
3. A new push, a conflict or failing CI can cancel auto-merge on the host. You are woken for the conflict or the failing check as usual; after you fix it and push, run `ost pr update <n> --ready` again to turn auto-merge back on.
4. If a work item asks you to merge, run `ost pr merge <n>`. The code checks the approvals, the required checks and the state of the pull request, then queues or merges it as the team's policy and the repository's settings say.
5. Never merge another way: not with `gh` or `git`, not in the host's web page, not by editing the pull request, its checks or the repository's settings. A refusal is the answer; report it and stop.

Do not rewrite the pull request's history or messages to get the merge through. How a repository wants commits and history handled is in its own files (`references/git.md`), and the host decides what it accepts.
