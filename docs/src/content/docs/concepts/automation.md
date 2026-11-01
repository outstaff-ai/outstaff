---
title: What outstaff does on its own
description: How the office decides what to do with every event, the built-in and custom policies, and the policies switches.
sidebar:
  order: 3
---

The office acts without being asked: it wakes an agent when a review lands, moves a ticket when its pull request merges, hands work back to the person who asked, and starts the next ready ticket when an agent runs out of work. This page explains how it decides.

Every event goes through one **event pipeline** ([decision 0016](/decisions/0016-event-pipeline/), the only way the office decides since [decision 0018](/decisions/0018-pipeline-only/)): policies that each propose to wake an agent, act for one, or drop the event, and an aggregation layer that turns their proposals into the decisions, and records why.

## Events

An event is anything that happened that the office might act on, from any source:

| Source     | Events                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat       | `chat.message`: a direct message, a mention or a thread reply to an agent, which the agent passes on to the office                                                                                                                                                                                                                                               |
| Code host  | `pr.opened`, `pr.review_submitted`, `pr.comment`, `pr.merged`, `pr.closed`                                                                                                                                                                                                                                                                                       |
| Work state | `pr.conflicted`, `pr.ci_failed` and `pr.ci_passed`, which the office raises itself when a pull request starts to conflict or its checks fail or turn green, `pr.base_merged` when the pull request it was stacked on merges, and `pr.linked` when an open pull request is linked to a ticket after it was opened; `pr.behind_base` is defined but not raised yet |
| Tracker    | `ticket.commented`, `ticket.assigned`, `ticket.moved`, `ticket.created`                                                                                                                                                                                                                                                                                          |
| Docs       | `doc.commented`                                                                                                                                                                                                                                                                                                                                                  |
| The office | `agent.started` when an agent accepts an item on a ticket, `agent.handed_back` when an agent hands an item back, and `agent.idle` when an agent has nothing queued or running and a ready ticket to start                                                                                                                                                        |

Each event has an actor (a human, an agent or automation). An event from an untrusted human is recorded, never acted on, and its trace says why. How the office reads each source, and who counts as trusted, is in [The office](/architecture/office/#intake).

## Three decisions

A policy proposes; the [aggregation layer](#from-proposals-to-decisions) decides. The decisions are three, and nothing else (an act can be followed by a wake):

- **wake** an agent: queue a work item for it with an instruction and the context. The instruction says what is expected ("address each point, answer in its thread and push"); the agent decides how, following the repository's conventions.
- **act** for an agent: make a bookkeeping change on the tracker (move a ticket, assign it, set its parent, link a pull request on it), without a model run. Anything that needs judgement is a wake. The agent's own process makes it, with the agent's tracker and knowledge accounts, so the ticket's history shows the agent; the policy's instruction, if any, is a note the agent posts with it. An agent that is offline makes it when it connects again. With no agent to act for, the act is dropped. An act can be followed by a wake of the agent it was for, as when a ticket is assigned back to an agent; it then posts no note, and the policy's instruction is the wake's.
- **drop** the event, with a reason.

The office writes nothing to the tracker, the knowledge base or the code host: its accounts there only read, and every change is made by an agent as itself ([decision 0019](/decisions/0019-agents-make-their-acts/)). It never merges and never messages people; every message a person reads in chat comes from an agent.

## The built-in policies

The office ships a built-in set, each policy a module of its own, listed with each policy's conditions and instruction in the generated [pipeline policies reference](/reference/pipeline-policies/). In short:

- **Wakes.** A chat message wakes the agent it was written to; a human's review or comment wakes the pull request's author; a conflict or failing checks wake the author; a ticket assigned to an agent by someone else, a comment on it, or a human moving it to active wakes the agent; a comment on a blocked ticket, by a human or another agent, wakes the agent blocked on it (the one who handed it back as blocked; an unblock round does not change that), to carry on if the comment unblocks the work and else to answer what is still missing, unless a human mentions an agent, the ticket is with an agent, or the commenting agent is in a round on the ticket; a human's comment on any other ticket an agent handed back (assigned to a human, in review or blocked, mentioning no agent) wakes the agent who last worked on it, to answer, and to take the ticket back only if it needs more work; any other comment by an agent wakes no one; a comment on a document wakes the agent it mentions, else its author; a blocked hand-back wakes the team's PM to unblock it; an idle agent is woken with its next ready ticket.
- **Acts.** A round of work starting on a ticket (an assignment, review feedback, a comment, a rebase or failing checks) assigns the ticket to the agent and moves it to active, unless it is done or canceled. A pull request opened for review moves its ticket to review; a merge into the default branch, with no other pull request of the ticket open, moves it to done. Both act as the pull request's author, or, for a human's pull request, as the ticket's agent: the agent it is assigned to, else the agent who last worked on it (with neither, the ticket is the human's alone and stays where it is). An agent's pull request opened for a ticket, or linked to one later, is linked on the ticket in the tracker (its development section), as the author, when the tracker can (`tracker.development`, which Its a Plan has); it posts no note and wakes no one, and the repository must be connected to the tracker (the office's doctor, `ost doctor --via-office`, warns about a writable one that is not). A hand-back moves the ticket to review (done) or blocked (blocked) and assigns it to the person who asked, except that a blocked one goes to the team's PM, who is woken to unblock it, when the team has a PM other than the blocked agent. A hand-back never undoes a hand-over: a ticket the agent gave to someone else during the work (anyone but itself and the person the hand-back would give it to) stays where it is, and the trace says why; a human moving a ticket they hold to active, without the needs-human label, assigns it back to the agent who last worked on it and wakes them.

Everything else on the ticket is the agent's: blocking, canceling, filing, splitting and re-parenting tickets, as its catalog instructions say.

Every policy that listens to an event receives it and proposes. Change one under `pipeline.policies.<id>`:

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

`enabled: false` turns a policy off (it still shows in the trace as turned off), `instruction` replaces the instruction of a wake or the note of an act, and `when` narrows it. An instruction with an unknown variable keeps the default, with a warning in the office log. The variables are listed in the [reference](/reference/pipeline-policies/#instruction-variables). One policy also follows a switch: `idle_pulls_next` is on only with `policies.pull_ready`.

## Policies of your own

A team adds policies of its own as code, under `policies.custom`: a module of its repository or an npm package, written with the `@outstaff/policy` SDK. They run after the built-in ones, show up in the trace like them, and `pipeline.policies.<id>` changes them the same way. YAML only turns policies on and off and tweaks them; new behaviour is a policy. See [Writing a policy](/guides/writing-a-policy/).

```yaml
policies:
  custom:
    - module: ./policies/release-freeze.ts
      settings: { until: "2026-12-01T00:00:00Z" }
```

## From proposals to decisions

The aggregation layer makes the decisions from every policy's proposals, the same way whichever policies made them:

- **Invariants.** It never acts as the office or for anyone who is not an agent on the team, never wakes an agent for its own action, lets the tracker's echo of one of its own acts wake no one (the event that caused the act already decided), lets no event a bot caused wake anyone (the loop guard), and keeps acts to bookkeeping. A proposal that breaks one is rejected.
- **Suppression.** A policy can propose that an agent is not woken (for example during a release freeze); that beats a wake, whatever the priorities.
- **Conflicts.** Two acts that set the same field of the same ticket are settled by the policies' priority, then by their order; the same change twice is made once. Each pull request linked on a ticket counts as a field of its own.
- **Merging.** Wakes of one agent on one subject, of one kind, become one run with every instruction.

Not in the default set yet: a mention handing a ticket to the agent mentioned (the agent is woken and takes the ticket itself if asked), and moving the ticket of a pull request a person opened or merged, which has no agent to act for.

## Why the office did something

Every event is traced: each policy, whether it matched and why, the first condition that failed, what it proposed, what the aggregation made of each proposal, the decisions, what each act did and what each wake's context carried. `ost explain --recent 20` lists the latest traced events; `ost explain <event-id>` prints one. A dashboard connected over the [office link](/reference/office-link/) shows the same traces. See the [CLI reference](/reference/cli/#ost-explain).

## Coalescing

Wakes that come close together become one run. Wakes for the same agent and the same pull request, ticket, document or chat conversation within `pipeline.wake.coalesce_seconds` (default 60) of the first are folded into one work item that carries all of them: four review comments left within a minute are one `review_feedback` round, a review and failing checks on one pull request are one run. The run starts when the window closes. `0` turns it off. A chat message is never held: it is answered at once, and a message that arrives while its session is still queued joins it. An idle pull is never held either. A wake also joins an item of the same kind and subject that is queued or running (a chat message only a chat session that has not started), and its feedback reaches a running item in a follow-up round. The trace of each folded event names the item and every event folded into it. See [Coalescing](/architecture/office/#coalescing).

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

| Switch                              | Default       | What outstaff does while it is on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policies.acknowledge.chat`         | `true`        | Reacts with eyes to a chat message from a trusted person as soon as the agent has seen it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `policies.acknowledge.vcs`          | `true`        | Reacts with eyes to each pull request comment the agent is about to answer, when its round starts. Needs a vcs adapter with `vcs.reactions`; `ost validate` warns when it lacks it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policies.chat.profile`             | `true`        | Publishes the agent's profile in chat (on Slack, the Home tab): its role, whether it is working or idle with when it was last active, and its current work grouped by ticket or pull request in queue order. Updates when the work changes and at least every 5 minutes while working. Needs a chat adapter with `chat.agentProfile`; `ost validate` warns when it lacks it.                                                                                                                                                                                                                                                                                                                                                                     |
| `policies.design.canvas`            | `true`        | Lets a role that declares the `design.canvas` capability (the stock designer) use Claude's Artifact tools to work on a private Design canvas, with an `~/artifacts/` folder that stays across items. Roles without the capability never get them. Needs the `claude-agent-sdk` runtime signed in with a Claude account; `ost doctor` checks the login, `ost validate` warns when the runtime lacks the capability. See [Design canvas](/guides/design-canvas/).                                                                                                                                                                                                                                                                                  |
| `policies.feedback.follow_up_round` | `true`        | Starts another round when feedback arrived after the agent was offered its work (a review comment, a chat request attached to the running item), so nothing written during a round is lost. The round goes to the same threads as the item it follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `policies.hand_back.blocked_notify` | `pm`          | Who tells the person who asked about blocked work that did not come from chat. With `agent`, or when the team has no PM role, the blocked agent tells them itself, in its own direct message with the ticket linked, what is needed and where the work is. With `pm` the blocked agent sends nothing and leaves it to the PM, who gives the ticket to the person who asked, saying exactly what is needed, only when it cannot unblock it. Whichever the value, a blocked ticket goes to the team's PM to unblock when the team has one; the switch only decides who sends the chat message. The thread of a chat item always gets its agent's reply, and items the scheduler blocks are handled the same way. The office never posts to people. |
| `policies.hand_back.fallback`       | `first_human` | When a ticket has no known requester, uses the first human in `humans` with a tracker identity. With `none`, an act that assigns the requester is dropped when the ticket has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policies.tickets.prs_per_ticket`   | `one`         | Keeps a ticket to one pull request: `ost pr open` refuses a second pull request for a ticket that already has one (open or merged), names it and points to `ost ticket create --parent <ticket>`, which splits the work into sub-tickets, one pull request each. A second pull request a person opens is not refused. With `many`, several pull requests are allowed. Either way the ticket moves to done when its last open pull request merges into the repository's default branch; a merge into another pull request's branch (a stack), or while another pull request of the ticket is still open, leaves it where it is.                                                                                                                   |
| `policies.pull_ready`               | `true`        | When an agent has nothing queued or running (when a ticket is created or assigned to it or moves into ready, after a hand-back, on the scheduler's tick, when it connects), the office starts its next ready ticket: one assigned to it and in the ready status, the highest tracker priority first, then the one that entered ready the longest ago. A ticket in backlog, one assigned to someone else, and one the agent already worked on since it entered ready are never pulled. This is what starts the tickets an agent assigns to itself, such as the pieces of a split. It counts as automatic work: usage above `usage.pause_automatic_at` stops it while humans are still answered, and the loop guard covers each item.              |
| `policies.merge.on_approval`        | `false`       | Lets agents merge their own approved pull requests, each merge their own decision: when an agent's pull request may be ready to merge, the office wakes its author with the merge context, and the agent merges it with `ost pr merge`, waits, or coordinates first. One merge runs per repository at a time. Off by default: no one is woken to merge and `ost pr merge` refuses. Needs a vcs adapter with `vcs.merge`; `ost validate` warns when it lacks it. `ost doctor` checks the code host's merge rules of each repository. See [Merging on approval](#merging-on-approval).                                                                                                                                                             |

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

Merging is the agent's decision, not a rule the office or the host applies. With the switch on, the `merge_ready` policy wakes the author of an agent's open, ready pull request with a `merge` work item when the pull request may be ready to merge:

- an allowed approver (`approvers`) approves it while its checks are green;
- its checks turn green (`pr.ci_passed`) while it is approved;
- the pull request it was stacked on merges (`pr.base_merged`) while it is approved.

It wakes no one while an allowed approver's request for changes is outstanding, while the checks are pending or failing, or for a repository outside `repos`. Marking a pull request ready sets nothing to merge, so a pull request that was ready before the switch was turned on merges the same way.

The wake carries a merge context, built by the office and kept short, each item with its link: the pull request's approvals, checks, mergeability and unresolved threads; the base branch's checks; the last few merges into the base; and the repository's other open pull requests with their author, state and how each relates to this one (stacked on it, the one it is stacked on, the same base, files both change). The agent decides with its usual tools: `ost pr merge <n>` to merge, ending the run to wait (the next readiness change wakes it again), or `ost ask` to coordinate the order with another agent or a person. The catalog's merge process says how to decide: stacks merge bottom-up, of two pull requests that change the same files the smaller first, nothing merges into a red base, and the authors a merge will make rebase hear of it first.

The scheduler runs one `merge` work item per repository at a time; the others wait, whoever they belong to, so two agents never decide "now" on the same facts. After a merge, the office re-checks the repository's other open pull requests and wakes the authors of those that now conflict, fall behind or lost their base, and the next waiting merge starts with fresh context.

`ost pr merge <n>` checks that the pull request is the caller's own, open, not a draft and mergeable, that an allowed approver approved its current head with no change requested or review pending, and that the required checks passed, then merges it with `method` (else what the repository has). Where the repository has a merge queue, merging means joining it. The office itself never merges: it sees `pr.merged` and moves the ticket as usual.

Approvers are people by default. `role:<role>` and agent handles are accepted for a reviewer agent later.

### The code host's rules are the gate

What stops an agent's pull request from merging untested or unreviewed is the code host's own rules: the required status checks and required reviews of the default branch's protection and rulesets. Outstaff only reads them; `repos[].checks` is the list of commands an agent runs before it pushes, not a merge gate, so there is nothing to copy into `team.yaml`. For every repository agents may merge (`merge.repos`, else every repository an agent can write to), `ost doctor office` and the office's own doctor runs (at start, daily and on demand) read the default branch's requirements through the vcs adapter and report:

- an **error** when the branch requires no status check and no approving review;
- a **warning** when it requires only one of the two.

The office stores and logs them with its other doctor checks (`ost doctor --via-office office` shows them) and starts anyway. On GitHub the adapter combines classic branch protection and every ruleset that applies to the branch: required checks are added up, the highest required approval count wins, and the branch must be up to date when any rule says so. Rulesets are read with the office App's Metadata permission. The full classic protection needs Administration: read on the office App; without it the adapter still reads the protected branch's required checks, and doctor warns that the review and up-to-date settings were not read.

### Approvals by GitHub Apps

Whether GitHub counts an approval from a GitHub App toward a branch protection rule's required approvals is not settled. The documentation says required approvals come from "people with write or admin permissions"; approvals by the Actions `GITHUB_TOKEN` count unless the organization turns off "Allow GitHub Actions to approve pull requests"; community reports about a dedicated App or a machine user conflict. Test it on a scratch repository before relying on it: require one approval, let the App approve, and read `mergeStateStatus` and `reviewDecision`.

The design holds either way, because the repository's rules are the gate. If an App's approval does not count, an agent reviewer's approval does not satisfy a repository that requires approvals, and `ost pr merge` is refused until a person approves; a team that wants agent reviews to count needs a ruleset that requires no approvals and relies on required status checks instead.

## Checks

An unknown key under `policies` is an error. A switch that is on but needs a capability the configured adapter does not declare, for example `acknowledge.vcs` with a vcs adapter without `vcs.reactions`, is a warning (`policies.capability_missing`); set the switch to `false` to silence it.
