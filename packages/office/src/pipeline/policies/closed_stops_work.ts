import { definePolicy, type PipelineEvent, type Proposal } from "@outstaff/policy";

/** Who closed the ticket, as the work state names them: `{ kind, id }`, or nothing when it does not know. */
function closerOf(event: PipelineEvent): { kind: string; id: string } | undefined {
  const { kind, id } = (event.data["closedBy"] ?? {}) as { kind?: unknown; id?: unknown };
  return typeof kind === "string" && typeof id === "string" && id !== "" ? { kind, id } : undefined;
}

/**
 * Why a closing stops nothing, or undefined. A ticket canceled always stops the work on it. One closed as done stops it
 * only when a human or an agent closed it: the agent's own merge closes its ticket as done, and a tracker's automation
 * or an unknown closer may be just that.
 */
function staysOpen(event: PipelineEvent): string | undefined {
  if (event.data["status"] === "canceled") {
    return undefined;
  }

  const by = closerOf(event);
  if (!by) {
    return "closed as done, and who closed it is not known: it may be the agent's own merge";
  }

  return by.kind === "human" || by.kind === "agent"
    ? undefined
    : `closed as done by ${by.kind} ${by.id}, which may follow the agent's own merge`;
}

export const policy = definePolicy({
  id: "closed_stops_work",
  summary:
    "A ticket canceled, or closed as done by someone other than the agent working on it, stops the work on it: every agent's queued work on it and its pull requests is canceled, and an agent running such work is told to stop when its round ends. The agent who closed the ticket is left alone.",
  on: ["ticket.closed"],
  when: { ticket_status: ["done", "canceled"] },
  instruction:
    "{{ticket}} was {{closed}} by {{closer}} at {{closed.at}}. Stop, and don't open a pull request for it. If the work belongs to another ticket, say which and hand back.",
  decides:
    "stop the work on the ticket of every agent but the one who closed it; a ticket closed as done by an unknown closer or an automation stops nothing",
  decide: (event, ctx): Proposal[] => {
    const ticket = ctx.ticket!;
    const open = staysOpen(event);
    if (open) {
      return [{ type: "drop", reason: open }];
    }

    // The policy has an instruction, and a team can only replace it with another.
    const notice = ctx.render(ctx.instruction!);
    if ("skip" in notice) {
      return [{ type: "drop", reason: `the notice cannot be rendered: ${notice.skip}` }];
    }

    const by = closerOf(event);
    return [
      {
        type: "stop",
        ticket,
        notice: notice.value,
        ...(by?.kind === "agent" ? { except: [by.id] } : {}),
        reason: `${ticket} was ${String(event.data["status"])} by ${by ? `${by.kind} ${by.id}` : "someone"}`,
      },
    ];
  },
});
