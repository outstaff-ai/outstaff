---
title: "0027: A failed merge check that passes later counts, and the PM rechecks blocks"
description: A check that failed on a merge commit counts as passed once the same check passes on a later commit of the default branch that contains the merge, and the PM is woken on a blocked ticket when something it may wait on happens.
sidebar:
  order: 27
---

**Status:** accepted. Amends [0023](/decisions/0023-ticket-closes-after-merge-checks/): a failed merge is no longer final, and a ticket whose merge failed may close without a new merge.

## Context

A deploy failed on a merge commit because of a problem in the CI environment, outside the pull request. The author found nothing to fix, handed the ticket back as blocked, and the PM, who could not unblock it, gave it to the human. The environment was fixed in another pull request and the deploy passed on later commits of the default branch, which contained the merge. Nothing looked at the ticket again: it stayed blocked with the human, and its parent stayed open behind it, until the human found it and closed it by hand. Under 0023 a merge is decided once, and only a later merge for the same ticket closes it.

## Decision

- **A failed merge check that passes later counts as passed.** While its ticket is open, the work state keeps following a merge whose checks failed: it reads the head of the default branch, once per head, and when each check that failed on the merge commit passed there (the same name, and the same workflow when the code host names one), and the head contains the merge commit, it raises `pr.merge_checks_passed` with `recoveredOn`, the head. Only the checks that failed on the merge commit count: a check the merge never ran is not approved by a later run. `merged_closes_ticket` closes the ticket as before, from blocked or from a human too, with a note naming the checks and the commit; the sub-ticket rules then close a parent.
- **The vcs port answers what a branch's head is and whether a commit contains another** (`branchHead`, `contains`, both optional), and names a check's workflow when asked (`checks(..., { workflows: true })`). A host without them keeps 0023's behaviour.
- **The PM rechecks a block when something it may wait on happens.** The work state raises `ticket.block_maybe_resolved` on a blocked ticket when one of several linked blockers closes, when a failed check of its merge passes later while its work goes on, or when the human it is assigned to writes about it on another ticket; at most once per ticket and cause in 24 hours. `blocked_maybe_resolved_to_pm` wakes the PM (kind `unblock`) to check whether the block holds, and to unblock or close the ticket with a comment when it does not. It is a policy like any other, and `policies.recheck_blocked: false` switches it off.

## Consequences

- A ticket blocked only on a failure outside its pull request closes on its own once the default branch is green again, with a note that says why.
- Following a failed merge costs a read of the branch head every poll, and a read of the head's checks and one comparison only when the head moves.
- Only the head of the default branch is read: a passing commit the branch moved past between two polls is not seen, and the next head decides.
- The work state derives these events from what it already reads; a blocked ticket that names a check or a pull request only in its text is not followed by them.
