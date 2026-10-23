import type {
  ActorKind,
  TrackerEvent,
  VcsEvent,
  WorkflowEvent,
  WorkflowEventType,
} from "@outstaff/core";

export interface Actor {
  kind: ActorKind;
  id: string;

  /** Only meaningful for humans. */
  trusted: boolean;
}

const VCS_TYPES: Partial<Record<VcsEvent["type"], WorkflowEventType>> = {
  "pr.opened": "pr.opened",
  "pr.merged": "pr.merged",
  "pr.closed": "pr.closed",
  "pr.review_submitted": "pr.review_submitted",
  "pr.comment": "pr.comment",
};

const TRACKER_TYPES: Record<TrackerEvent["type"], WorkflowEventType> = {
  created: "ticket.created",
  assigned: "ticket.assigned",
  moved: "ticket.moved",
  commented: "ticket.commented",
};

function build(
  type: WorkflowEventType,
  subject: WorkflowEvent["subject"],
  actor: Actor,
  at: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  const flagged = actor.kind === "human" && !actor.trusted;
  return {
    type,
    subject,
    actor: { kind: actor.kind, id: actor.id },
    data: { ...data, at, ...(flagged ? { untrusted: true } : {}) },
  };
}

/** `pr.synchronize` and anything unknown map to nothing: the work state derives conflicts and CI from it. */
export function normalizeVcsEvent(event: VcsEvent, actor: Actor): WorkflowEvent | undefined {
  const type = VCS_TYPES[event.type];
  if (!type) {
    return undefined;
  }

  return build(
    type,
    { pr: { repo: event.repo, number: event.number } },
    actor,
    event.at,
    event.data,
  );
}

export function normalizeTrackerEvent(
  event: TrackerEvent,
  actor: Actor,
): WorkflowEvent | undefined {
  const type = TRACKER_TYPES[event.type];
  if (!type) {
    return undefined;
  }

  return build(type, { ticket: event.key }, actor, event.at, event.data);
}
