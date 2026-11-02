---
title: "0023: A ticket closes once the checks on its merge commit pass"
description: A merge no longer closes its ticket at once; the office follows the checks on the merge commit, wakes the ticket's agent with the failed log when one fails, and a ticket takes a new pull request while its merged one needs a fix.
sidebar:
  order: 23
---

**Status:** accepted. Replaces the merge row of [0016](/decisions/0016-event-pipeline/)'s policy table ("`pr.merged` into the default branch: ticket to done") and, from [0011](/decisions/0011-configurable-workflow/), the rule that `ost pr open` refuses a ticket with a merged pull request.

## Context

`merged_closes_ticket` moved a ticket to done the moment its pull request merged. Checks that run on the merge commit in the default branch, such as a deploy workflow, were not considered. In live use a deploy failed on a configuration error after the merge; the ticket was already done, the agent noticed only by chance, and it could not read why the deploy failed, because agents have no access to the CI's logs. A human had to fetch the error from the run. The fix then needed a new pull request, which `ost pr open` refused, because the ticket already had a merged one.

## Decision

- **The work state follows the checks on the merge commit** of every pull request it sees merge into the default branch, from the store, so across restarts, and raises one event per merge: `pr.merge_checks_failed` when a check fails, is cancelled or times out, or is still running after `policies.merge_checks.timeout_minutes`; `pr.merge_checks_passed` when every check finished without failing and no new one appeared for `policies.merge_checks.settle_minutes`, so a workflow that starts after the first ones finish is still waited for, or when none started within `policies.merge_checks.wait_for_start_minutes`.
- **`merged_closes_ticket` acts on `pr.merge_checks_passed`**, with the conditions it had on `pr.merged`.
- **A failed check wakes the ticket's agent** (`merge_checks_failed_to_agent`, kind `merge_checks_failed`): the pull request's author, or, for a human's pull request, the agent the ticket is assigned to, else the one who last worked on it. With none, the event is dropped and the trace says why. The ticket stays open.
- **The office reads the log for the agent** with its own code host credentials: the wake carries the end of the failed step's log, bounded, with secrets masked and marked as data, and `ost ci log <check link>` reads more through the office, for the team's repositories only. Agents need no CI access of their own.
- **One open pull request per ticket.** `ost pr open` refuses a ticket with another open pull request, or one that is done or canceled. A merged one does not count while the ticket is open, so the fix goes on the same ticket.

## Consequences

- A ticket closes a few minutes after its merge instead of at once: at least the settle time when checks ran, the wait for a first check when none did.
- The office's GitHub App needs Actions: read; the doctor reports it when it is missing.
- A check that never reports on the merge commit, or reports after the wait for a first check, is not waited for.
