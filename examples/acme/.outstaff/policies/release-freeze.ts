// A custom policy of the synthetic acme team, loaded from team.yaml (`policies.custom`). During a release freeze it
// keeps agents from starting new work: an assignment, or a move to active, of a ticket without the hotfix label wakes
// no one until the freeze ends. Work already running and every other wake go on as usual.
//
// The office loads this file as it is, so it imports only types: `import type` is erased when the module loads, and
// the team's repository needs no node_modules. Its tests use the SDK's harness.
import type { PipelineEvent, PolicyContext, PolicyDefinition, Proposal } from "@outstaff/policy";

function decide(event: PipelineEvent, ctx: PolicyContext): Proposal[] {
  const until = ctx.settings["until"];
  const label = ctx.settings["label"] ?? "hotfix";
  if (typeof until !== "string" || event.at >= until) {
    return [];
  }

  if (typeof label === "string" && ctx.check({ has_label: label }).ok) {
    return [
      { type: "drop", reason: `${ctx.ticket} is labelled ${label}: the freeze lets it through` },
    ];
  }

  const assignee = ctx.person("assignee");
  if ("skip" in assignee) {
    return [];
  }

  return [
    {
      type: "suppress",
      person: assignee.value,
      ...(ctx.ticket ? { subject: { type: "ticket", ref: ctx.ticket } } : {}),
      reason: `release freeze until ${until}: new work waits`,
    },
  ];
}

export const policy = {
  id: "release_freeze",
  summary:
    "During a release freeze (settings.until), assigning a ticket or moving it to active wakes no one, unless it has the hotfix label (settings.label).",
  on: ["ticket.assigned", "ticket.created", "ticket.moved"],
  when: { assignee_kind: "agent" },
  decides: "suppress the wake of `assignee` on the ticket",
  decide,
} satisfies PolicyDefinition;
