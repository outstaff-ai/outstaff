---
title: Writing a policy
description: Add behaviour to the office as a policy of your own, written with the @outstaff/policy SDK, loaded from team.yaml and tested by replaying events.
---

Everything the office does on its own comes from the policies of its [event pipeline](/concepts/automation/). The [built-in ones](/reference/pipeline-policies/) cover the common work. When your team needs something they do not do, write a policy: a small TypeScript module that receives events and proposes what to do. YAML only turns policies on and off and tweaks them; new behaviour is code.

This guide uses the policy of the synthetic acme team, `release_freeze`, which keeps agents from starting new work during a release freeze. It is in `examples/acme/.outstaff/policies/release-freeze.ts`, and its test in `packages/policy/src/__tests__/example.test.ts`.

## Where a policy lives

A policy is a module of your team's repository, or an npm package. List it under `policies.custom` in team.yaml:

```yaml
policies:
  custom:
    - module: ./policies/release-freeze.ts # relative to team.yaml
      settings:
        until: "2026-12-01T00:00:00Z"
        label: hotfix
    - package: "@acme/outstaff-policy-oncall"
```

- A module exports its policy as `policy`, or several as a `policies` list.
- A `.ts` module is loaded as it is, without a build: write only TypeScript that Node.js can strip (no `enum`, no `namespace`), and import from `@outstaff/policy` with `import type`, which is erased when the module loads. Your repository then needs no `node_modules` for the office to load it. Install `@outstaff/policy` as a dev dependency for your editor and your tests.
- A package is resolved from your repository's `node_modules`, else from the office's own. A package can use `definePolicy` at runtime, since it brings its dependencies.
- `settings` is passed to the policy as `ctx.settings`. What it accepts is up to the policy.
- `ost validate` loads every custom policy as the office will and checks it against the SDK's schema; a problem is an error with the code `policies.custom_invalid`, at the entry's line. The office does not start with a custom policy it cannot load.
- Custom policies run after the built-in ones. An id a built-in or an earlier custom policy already has is a warning in the office log, and the later policy is not loaded.

`pipeline.policies.<id>` changes a custom policy like a built-in one: `enabled: false` turns it off, `instruction` replaces its instruction, and `when` narrows it.

## The policy

```ts
import type { PipelineEvent, PolicyContext, PolicyDefinition, Proposal } from "@outstaff/policy";

function decide(event: PipelineEvent, ctx: PolicyContext): Proposal[] {
  const until = ctx.settings["until"];
  if (typeof until !== "string" || event.at >= until) {
    return [];
  }

  const assignee = ctx.person("assignee");
  return "skip" in assignee
    ? []
    : [{ type: "suppress", person: assignee.value, reason: `release freeze until ${until}` }];
}

export const policy = {
  id: "release_freeze",
  summary: "During a release freeze, assigning a ticket wakes no one.",
  on: ["ticket.assigned", "ticket.created", "ticket.moved"],
  when: { assignee_kind: "agent" },
  decide,
} satisfies PolicyDefinition;
```

The fields:

| Field         | What it is                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Lowercase letters, digits and underscores. Names the policy in the trace and under `pipeline.policies`.                                                                                                  |
| `summary`     | One line for `ost explain` and the docs.                                                                                                                                                                 |
| `on`          | The [event types](/reference/pipeline-policies/#events) the policy receives.                                                                                                                             |
| `when`        | Optional. A [condition](/reference/team-yaml/#pipelinepolicies), checked before `decide`; when it does not hold the policy proposes nothing, and the trace names the part that failed.                   |
| `instruction` | Optional. A template with [`{{variables}}`](/reference/pipeline-policies/#instruction-variables): the instruction of a wake, or the note posted with an act. `ost validate` rejects an unknown variable. |
| `decides`     | Optional. What the policy decides, in one line, for a reference page.                                                                                                                                    |
| `priority`    | Optional, default 0. Settles two acts on the same ticket field: the higher wins.                                                                                                                         |
| `decide`      | `(event, ctx) => Proposal[]`. Pure: it reads the context and returns proposals. No I/O, no clock (use `event.at`), no state between calls.                                                               |

## The context

`ctx` is a read-only view of the office for one event:

- `ctx.event`: the event, as the trace shows it (`type`, `at`, `subject`, `actor`, `data`).
- `ctx.state`: the work state after the event: tickets with their status, assignee, labels, requester and last worker; pull requests, their links to tickets and their stacks; documents and their authors; each agent's ready tickets. It answers questions; it changes nothing.
- `ctx.options`: what the team file tells the policies: the team's agents (`people`), its humans, the needs-human label, who approves merges.
- `ctx.ticket` and `ctx.pr`: the ticket the event is about (or the one its pull request is linked to), and the event's pull request.
- `ctx.settings`: the entry's `settings`.
- `ctx.instruction`: the policy's instruction, the team's replacement if it set one.
- `ctx.matched`: why `when` held; the default reason of the helpers' proposals.

And helpers, all pure:

- `ctx.check(condition)`: whether a condition holds, and why. The same conditions as `when`.
- `ctx.person(spec)`: the agent a name such as `assignee`, `author`, `last_worker`, `mentioned` or `role:pm` refers to, or why there is none (`{ skip }`).
- `ctx.render(template, { person, next })`: a template with the event's variables.
- `ctx.wake({ person, kind })`: a wake with the policy's instruction, or a drop saying why no one can be woken.
- `ctx.act({ as, ops, wake, note })`: bookkeeping changes for an agent (`{ move }`, `{ assign: "self" | "requester" }` or `{ assign }` with a person such as `role:pm`, `{ set_parent: true }`), only those still needed, then the wake of that agent if asked; or a drop saying why. The note posted with the changes is `note` when given, else the policy's instruction, so a policy that both acts and wakes someone else can give each its own text.

## Proposals

A policy proposes; it never decides alone. Each proposal has a `reason`:

- `wake`: wake an agent with an instruction. Its subject is the event's unless it names one; its feedback is the event's.
- `act`: change the tracker for an agent, without a model run: move a ticket, assign it, set its parent. Nothing else: anything that needs judgement is a wake.
- `drop`: nothing to do, recorded so it can be explained.
- `suppress`: keep another policy's wake of an agent from happening, narrowed by `subject` and `kind` when given.

## From proposals to decisions

The aggregation layer makes the decisions from the proposals of every policy, in this order:

1. **Invariants**, the same for every policy. A proposal that breaks one is rejected, and dropped with the reason:
   - an act for, or a wake or suppression of, anyone who is not an agent on the team: the office never acts as itself;
   - a wake of the agent who caused the event: an agent is never woken for its own action (the office's idle pull for an agent is the exception);
   - an act's echo: the tracker's report of a change an act made (marked `echo` in the event's data) wakes no one, since the event that caused the act already decided whom to wake;
   - the loop guard: an event a bot caused wakes no one, except the office's own merge, conflict and CI checks;
   - an act with an op other than move, assign or set parent;
   - a second act of the same policy for the event: return one act with every change.
2. **Suppressions.** A suppression beats every wake it matches, whatever the priorities. The wake is dropped, saying which policy suppressed it.
3. **Conflicts.** Two acts that set the same field (status, assignee, parent) of the same ticket: the change of the policy with the higher `priority` is made, on a tie the one listed first, and the other is dropped. The same change twice is made once. An act left with nothing to change is dropped.
4. **Merging.** Wakes of one agent on one subject, of one kind, become one run, with every distinct instruction. A chat wake is answered at once; any other waits `pipeline.wake.coalesce_seconds` for related wakes to join it.

The trace of every event shows each policy's proposals, then what the aggregation made of each one (kept, merged, suppressed, rejected, dropped or error) and why, then the decisions. `ost explain <event-id>` prints it, and the [office link](/reference/office-link/) serves it.

## Test it

The SDK's harness replays recorded events through a policy, as the office's bus runs it, and returns its proposals, ready for a snapshot:

```ts
import { formatReplay, harnessEvent, replayPolicy } from "@outstaff/policy";
import { policy } from "../policies/release-freeze.ts";

const results = replayPolicy(
  { ...policy, settings: { until: "2026-12-01T00:00:00Z" } },
  [
    {
      event: harnessEvent("ticket.assigned", {
        at: "2026-11-20T10:00:00.000Z",
        subject: { ticket: "ACME-7" },
      }),
      world: { tickets: { "ACME-7": { status: "ready", assignee: { id: "sam", kind: "agent" } } } },
    },
  ],
  { people: ["sam"] },
);

expect(formatReplay(results)).toMatchSnapshot();
```

Each step is an event and the world after it: tickets, pull requests and their links, documents, ready tickets. `loadCustomPolicies(entries, dir)` loads policies the way `ost validate` and the office do, if your test should start from team.yaml.

## Trust

A custom policy runs in the office process, with the office's access. It is as trusted as your team's repository, and only the team's own config can load one. The read-only context and proposals-only design limit what a buggy policy can do: it cannot change the tracker or wake anyone except through the aggregation's invariants, and one that throws is contained and traced as an error while the other policies decide as usual. That is not a sandbox: a malicious module can do anything the office process can. Review a policy, and the packages it pulls in, like any code that runs your office.
