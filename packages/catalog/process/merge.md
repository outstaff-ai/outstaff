# Merge

Use this when a work item asks you to merge your own pull request: an allowed approver approved it and the team turned on merging on approval. The work prompt names the pull request.

1. Run `ost pr merge <n>`. The code checks the approvals, the required checks and the state of the pull request, then puts it in the host's merge queue or merges it as the team's policy and the repository's settings say. You do not choose the method.
2. Report the result in the journal and hand back as in `process/hand-back.md`: merged, queued (the host merges it when its queue passes), or refused, with the reasons the verb listed.
3. Never retry a refusal by other means: not with `gh` or `git`, not in the host's web page, not by editing the pull request, its checks or the repository's settings. A refusal is the answer. If it names review feedback, handle that as in `process/review-loop.md`; otherwise report it and stop.

Do not rewrite the pull request's history or messages to get the merge through. How a repository wants commits and history handled is in its own files (`references/git.md`), and the host decides what it accepts.
