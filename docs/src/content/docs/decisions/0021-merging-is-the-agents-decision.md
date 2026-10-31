---
title: "0021: Merging is the agent's decision"
description: Marking a pull request ready no longer turns on the host's auto-merge; the office wakes the author with the merge context when its pull request may be ready, and the agent decides.
sidebar:
  order: 21
---

**Status:** accepted. Replaces the merge decision of [0016](/decisions/0016-event-pipeline/) ("The office never merges"): the office still never merges, but the host's auto-merge on ready is gone.

## Context

With `policies.merge.on_approval` on, an agent marking its pull request ready turned on the host's auto-merge or joined the merge queue, and the repository's rules alone decided when it merged. Approving it woke no one. That fell short in two ways:

- **Merging is a judgement, not a rule check.** Required approvals and checks do not cover order (a stack merges bottom-up; of two approved pull requests that change the same files, one goes first and the other rebases), timing (a red base, a deploy, another agent mid-way through work the merge breaks) or people (whose pull requests depend on or conflict with this one, and who needs a heads-up).
- **It missed pull requests.** Auto-merge was set only at the moment a pull request became ready, so one that was ready before merging was turned on never got it.

The office acts for an agent without waking it only for bookkeeping that follows mechanically from an event. Anything that needs judgement wakes the agent, with the facts it needs. Merging needs judgement.

## Decision

- **No auto-merge on ready.** `ost pr open` and `ost pr update --ready` set nothing to merge. `policies.merge.on_approval` means agents may merge their own approved pull requests. `ost pr merge` keeps every check it makes; where the repository has a merge queue, merging means joining it.
- **The `merge_ready` policy wakes the author** (kind `merge`) of an agent's open, ready pull request, in a repository within `policies.merge.repos`, when it may be ready to merge: an allowed approver approves it while its checks are green; its checks turn green (`pr.ci_passed`, a new event the work state raises) while it is approved; the pull request it was stacked on merges (`pr.base_merged`, which the work state now raises after a merge) while it is approved. Never while an allowed approver's request for changes is outstanding, nor while the checks are pending or failing.
- **The wake carries a merge context**, built by the office and bounded, each item with its link: the pull request's approvals, checks, mergeability and unresolved threads; the repository's other open pull requests with their author, state and relation (stacked on it, under it, same base, overlapping files, read from the diffs); the latest merges into the base; and the base's checks. It is recorded in the trace of the event that woke the item.
- **The agent decides with its usual tools:** merge with `ost pr merge`, wait by ending the run (the next readiness change wakes it again), or coordinate with `ost ask`. The catalog's merge process gives the order (stacks bottom-up, the smaller of two overlapping pull requests first), says to wait on a red base, to tell the authors a merge will make rebase, and to ask a human when unsure.
- **One merge per repository at a time.** The scheduler runs at most one `merge` item per repository; the others wait, whoever they belong to, and are offered when it ends. A merge wake folds only into a queued merge item, never into another kind of run.

## Consequences

- An approval wakes the author: a model run for every merge, which buys order, timing and coordination the repository's rules cannot express.
- Two agents never decide "now" on the same stale facts in one repository; after a merge, the re-check wakes the authors of pull requests that now conflict or lost their base, and the next merge starts with fresh context.
- A pull request that was ready before merging was turned on merges like any other after its approval.
- The vcs port keeps `enableAutoMerge` and `enqueue`; nothing in outstaff calls them now.
