---
title: What outstaff does on its own
description: How the office decides what to do with every event, the default policies, and the policies switches.
sidebar:
  order: 3
---

The office acts without being asked: it wakes an agent when a review lands, moves a ticket when its pull request merges, hands work back to the person who asked, and starts the next ready ticket when an agent runs out of work. This page explains how it decides.

Every event goes through one **event pipeline** ([decision 0016](/decisions/0016-event-pipeline/), the only way the office decides since [decision 0018](/decisions/0018-pipeline-only/)): an ordered list of policies that decides to wake an agent, act for one, or drop the event, and records why.

## Events

An event is anything that happened that the office might act on, from any source:

| Source     | Events                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat       | `chat.message`: a direct message, a mention or a thread reply to an agent, which the agent passes on to the office                                                                                 |
| Code host  | `pr.opened`, `pr.review_submitted`, `pr.comment`, `pr.merged`, `pr.closed`                                                                                                                         |
| Work state | `pr.conflicted` and `pr.ci_failed`, which the office raises itself when a pull request starts to conflict or its checks fail; `pr.behind_base` and `pr.base_merged` are defined but not raised yet |
| Tracker    | `ticket.commented`, `ticket.assigned`, `ticket.moved`, `ticket.created`                                                                                                                            |
| Docs       | `doc.commented`                                                                                                                                                                                    |
| The office | `agent.handed_back` when an agent hands an item back, and `agent.idle` when an agent has nothing queued or running and a ready ticket to start                                                     |

Each event has an actor (a human, an agent or automation). An event from an untrusted human is recorded, never acted on, and its trace says why. How the office reads each source, and who counts as trusted, is in [The office](/architecture/office/#intake).

## Three decisions

A policy decides one of three things, and nothing else (an act can be followed by a wake):

- **wake** an agent: queue a work item for it with an instruction and the context. The instruction says what is expected ("address each point, answer in its thread and push"); the agent decides how, following the repository's conventions.
- **act** for an agent: make a tracker change (move a ticket, assign it, comment, set its parent) or comment on a document, without a model run. The office makes it with its own tracker and knowledge accounts and posts a note naming the agent it was for, so the ticket's history says who the change served. With no agent to act for, the act is dropped. An act can be followed by a wake of the agent it was for, as when a ticket is assigned back to an agent; it then posts no note, and the policy's instruction is the wake's.
- **drop** the event, with a reason.

The office's write scope is tracker coordination metadata: status, assignee, labels, parent and those notes. On the code host it is strictly read-only. It never merges and never messages people; every message a person reads in chat comes from an agent. Making each act with the agent's own tracker account, so the office's tracker account can be read-only, is planned ([decision 0018](/decisions/0018-pipeline-only/)).

## The default policies

The office ships a default set, listed with each policy's conditions and instruction in the generated [pipeline policies reference](/reference/pipeline-policies/). In short:

- **Wakes.** A chat message wakes the agent it was written to; a human's review or comment wakes the pull request's author; a conflict or failing checks wake the author; a ticket assigned to an agent by someone else, a comment on it, or a human moving it to active wakes the agent; a human's comment on a ticket an agent handed back (assigned to a human, in review or blocked, mentioning no agent) wakes the agent who last worked on it, to answer, and to take the ticket back only if it needs more work; a comment on a document wakes the agent it mentions, else its author; an idle agent is woken with its next ready ticket.
- **Acts.** A pull request opened for review moves its ticket to review; a merge into the default branch, with no other pull request of the ticket open, moves it to done; a hand-back moves the ticket to review (done) or blocked (blocked) and assigns it to the person who asked; a human moving a ticket they hold to active, without the needs-human label, assigns it back to the agent who last worked on it and wakes them.

Everything else on the ticket is the agent's: a woken agent assigns the ticket to itself and moves it to active when it starts work on it, as its catalog instructions say.

Every policy is evaluated for every event, in order, and every one that matches contributes its decision. Change one under `pipeline.policies.<id>`:

```yaml
pipeline:
  policies:
    ci_failed_to_author:
      instruction: "Checks fail on #{{pr.number}} ({{pr.title}}). Fix the cause and push."
    review_to_author:
      when: { not: { has_label: wip } } # narrows the policy: its own condition and this one must hold
    moved_active_to_assignee:
      enabled: false
```

`enabled: false` turns a policy off (it still shows in the trace as turned off), `instruction` replaces the instruction of a wake or the note of an act, and `when` narrows it. An instruction with an unknown variable keeps the default, with a warning in the office log. The variables are listed in the [reference](/reference/pipeline-policies/#instruction-variables). One policy also follows a switch: `idle_pulls_next` is on only with `policies.pull_ready`. A team cannot add policies of its own.

Not in the default set yet: the PM's round to unblock a blocked hand-back (the ticket goes to the person who asked), a mention handing a ticket to the agent mentioned (the agent is woken and takes the ticket itself if asked), and moving the ticket of a pull request a person opened or merged, which has no agent to act for.

## Why the office did something

Every event is traced: each policy, whether it matched and why, the first condition that failed, the decisions, what each act did and what each wake's context carried. `ost explain --recent 20` lists the latest traced events; `ost explain <event-id>` prints one. A dashboard connected over the [office link](/reference/office-link/) shows the same traces. See the [CLI reference](/reference/cli/#ost-explain).

## Coalescing

Wakes that come close together become one run. Wakes for the same agent and the same pull request, ticket, document or chat conversation within `pipeline.wake.coalesce_seconds` (default 60) of the first are folded into one work item that carries all of them: four review comments left within a minute are one `review_feedback` round, three quick chat messages are one chat session. The run starts when the window closes. `0` turns it off, and an idle pull is never held. A wake also joins an item of the same kind and subject that is queued or running (a chat message only a chat session that has not started), and its feedback reaches a running item in a follow-up round. The trace of each folded event names the item and every event folded into it. See [Coalescing](/architecture/office/#coalescing).

## Wake context

Every wake hands the agent what the office already knows about the work: the tickets, pull requests, documents and chat threads the item is linked to, each with its link and why it belongs, within the `pipeline.context` limits of team.yaml. The agent starts from that and the wake's instruction instead of rediscovering them with several verb calls. What the bundle carried is added to the event's trace. See [Wake context](/architecture/office/#wake-context).

## The policies switches

A few behaviours outside the pipeline's decisions have a named switch under `policies` in `.outstaff/team.yaml`: what agents do on their own, the office's own bookkeeping, and options the policies read. Everything that happens today is on by default; a team that wants less turns a switch off. Anything that merges, approves or acts without a human in the loop is off until a team opts in.

```yaml
policies:
  acknowledge: { chat: true, vcs: true }
  chat: { profile: true }
  design: { canvas: true }
  feedback: { follow_up_round: true }
  hand_back: { blocked_notify: pm, fallback: first_human }
  tickets: { prs_per_ticket: one }
  pull_ready: true
  merge: { on_approval: false }
```

Run `ost policies` to see every switch with its effective value and where the value comes from.

### The behaviours

| Switch                              | Default       | What outstaff does while it is on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies.acknowledge.chat`         | `true`        | Reacts with eyes to a chat message from a trusted person as soon as the agent has seen it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `policies.acknowledge.vcs`          | `true`        | Reacts with eyes to each pull request comment the agent is about to answer, when its round starts. Needs a vcs adapter with `vcs.reactions`; `ost validate` warns when it lacks it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `policies.chat.profile`             | `true`        | Publishes the agent's profile in chat (on Slack, the Home tab): its role, whether it is working or idle with when it was last active, and its current work grouped by ticket or pull request in queue order. Updates when the work changes and at least every 5 minutes while working. Needs a chat adapter with `chat.agentProfile`; `ost validate` warns when it lacks it.                                                                                                                                                                                                                                                                                                                                                        |
| `policies.design.canvas`            | `true`        | Lets a role that declares the `design.canvas` capability (the stock designer) use Claude's Artifact tools to work on a private Design canvas, with an `~/artifacts/` folder that stays across items. Roles without the capability never get them. Needs the `claude-agent-sdk` runtime signed in with a Claude account; `ost doctor` checks the login, `ost validate` warns when the runtime lacks the capability. See [Design canvas](/guides/design-canvas/).                                                                                                                                                                                                                                                                     |
| `policies.feedback.follow_up_round` | `true`        | Starts another round when feedback arrived after the agent was offered its work (a review comment, a chat request attached to the running item), so nothing written during a round is lost. The round goes to the same threads as the item it follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policies.hand_back.blocked_notify` | `pm`          | Who tells the person who asked about blocked work that did not come from chat. With `agent`, or when the team has no PM role, the blocked agent tells them itself, in its own direct message with the ticket linked, what is needed and where the work is. With `pm` the blocked agent sends nothing and leaves it to the PM; the hand-back still gives the ticket to the person who asked. The thread of a chat item always gets its agent's reply, and items the scheduler blocks are handled the same way. The office never posts to people.                                                                                                                                                                                     |
| `policies.hand_back.fallback`       | `first_human` | When a ticket has no known requester, uses the first human in `humans`. With `none`, an act that assigns the requester is dropped when the ticket has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `policies.tickets.prs_per_ticket`   | `one`         | Keeps a ticket to one pull request: `ost pr open` refuses a second pull request for a ticket that already has one (open or merged), names it and points to `ost ticket create --parent <ticket>`, which splits the work into sub-tickets, one pull request each. A second pull request a person opens is not refused. With `many`, several pull requests are allowed. Either way the ticket moves to done when its last open pull request merges into the repository's default branch; a merge into another pull request's branch (a stack), or while another pull request of the ticket is still open, leaves it where it is.                                                                                                      |
| `policies.pull_ready`               | `true`        | When an agent has nothing queued or running (when a ticket is created or assigned to it or moves into ready, after a hand-back, on the scheduler's tick, when it connects), the office starts its next ready ticket: one assigned to it and in the ready status, the highest tracker priority first, then the one that entered ready the longest ago. A ticket in backlog, one assigned to someone else, and one the agent already worked on since it entered ready are never pulled. This is what starts the tickets an agent assigns to itself, such as the pieces of a split. It counts as automatic work: usage above `usage.pause_automatic_at` stops it while humans are still answered, and the loop guard covers each item. |
| `policies.merge.on_approval`        | `false`       | Lets agents turn on the code host's auto-merge on their pull requests: when an agent marks a pull request ready (`ost pr update <n> --ready`, or `ost pr open` without `--draft`), the same verb turns on auto-merge, or adds it to the merge queue where the repository has one. The repository's rules decide when it merges; no agent runs for the merge and the office only sees it merge. Off by default. Needs a vcs adapter with `vcs.merge`; `ost validate` warns when it lacks it. `ost doctor` checks the code host's merge rules of each repository. See [Merging on approval](#merging-on-approval).                                                                                                                    |

`policies.retry` holds the backoff settings (`base_minutes`, `cap_minutes`, `max_failures`) that decide when a failing item is blocked. A blocked item is not retried by itself: a human's comment, review or assignment wakes the agent with a new round, and the office closes the agent's blocked items on a ticket once later work on it finishes.

### Removed switches

`office.pipeline`, `workflow.preset`, `workflow.rules`, `workflow.templates` and the switches that only changed workflow rules (`policies.feedback.merged_prs`, `doc_comments`, `ticket_comments`, `mentions`, `policies.hand_back.reassign`, `policies.conflicts.follow_up`, `policies.retry.on_signal`, `policies.tickets.start_moves_active`) are gone. `ost validate` reports each as a removed key (`schema.removed_key`) and says what to use instead, usually `pipeline.policies.<id>.enabled: false`.

## Merging on approval

```yaml
policies:
  merge:
    on_approval: true
    repos: [app] # optional; default every repo an agent can write to
```

Merging is the code host's job. With the switch on, an agent that marks its pull request ready for review (`ost pr update <n> --ready`, or `ost pr open` without `--draft`) also, in the same verb and as itself, turns on the host's auto-merge, or adds the pull request to the merge queue where the repository has one (a pull request the queue does not take yet gets auto-merge, which joins the queue once the rules are met). From then on the repository's rules decide: once its required approvals and checks are met, the host merges it with the repository's own merge method. No agent is woken for the merge, and the office does not merge: it sees `pr.merged` and moves the ticket as usual. If the host cancels auto-merge (new commits, a conflict, failing CI), the conflict and CI policies send the pull request back to its author, who fixes it and marks it ready again to turn auto-merge back on. If the verb cannot turn auto-merge on (the repository does not allow it, for example), the pull request is still ready, the verb says why, and a person merges it.

An approval wakes nobody. An agent asked to merge runs `ost pr merge <n>`, which checks that the pull request is the caller's own, open, not a draft and mergeable, that an allowed approver (`approvers`) approved its current head with no change requested or review pending, and that the required checks passed, then queues or merges it with `method` (else what the repository has). The same switch allows the verb.

Approvers are people by default. `role:<role>` and agent handles are accepted for a reviewer agent later.

### The code host's rules are the gate

What stops an agent's pull request from merging untested or unreviewed is the code host's own rules: the required status checks and required reviews of the default branch's protection and rulesets. Outstaff only reads them; `repos[].checks` is the list of commands an agent runs before it pushes, not a merge gate, so there is nothing to copy into `team.yaml`. For every repository agents may merge (`merge.repos`, else every repository an agent can write to), `ost doctor office` and the office's own doctor runs (at start, daily and on demand) read the default branch's requirements through the vcs adapter and report:

- an **error** when the branch requires no status check and no approving review;
- a **warning** when it requires only one of the two.

The office stores and logs them with its other doctor checks (`ost doctor --via-office office` shows them) and starts anyway. On GitHub the adapter combines classic branch protection and every ruleset that applies to the branch: required checks are added up, the highest required approval count wins, and the branch must be up to date when any rule says so. Rulesets are read with the office App's Metadata permission. The full classic protection needs Administration: read on the office App; without it the adapter still reads the protected branch's required checks, and doctor warns that the review and up-to-date settings were not read.

### Approvals by GitHub Apps

Whether GitHub counts an approval from a GitHub App toward a branch protection rule's required approvals is not settled. The documentation says required approvals come from "people with write or admin permissions"; approvals by the Actions `GITHUB_TOKEN` count unless the organization turns off "Allow GitHub Actions to approve pull requests"; community reports about a dedicated App or a machine user conflict. Test it on a scratch repository before relying on it: require one approval, let the App approve, and read `mergeStateStatus` and `reviewDecision`.

The design holds either way, because the repository's rules are the gate. If an App's approval does not count, an agent reviewer's approval does not satisfy a repository that requires approvals, and an auto-merge waits for a person's; a team that wants agent reviews to count needs a ruleset that requires no approvals and relies on required status checks instead.

## Checks

An unknown key under `policies` is an error. A switch that is on but needs a capability the configured adapter does not declare, for example `acknowledge.vcs` with a vcs adapter without `vcs.reactions`, is a warning (`policies.capability_missing`); set the switch to `false` to silence it.
