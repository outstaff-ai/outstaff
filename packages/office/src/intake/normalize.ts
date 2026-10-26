import type {
  ActorKind,
  TeamConfig,
  DocEvent,
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

/** A comment or reply on a document, with the ticket the work state linked the document to. */
export function normalizeDocEvent(
  event: DocEvent,
  actor: Actor,
  ticket: string | undefined,
): WorkflowEvent {
  return build(
    "doc.commented",
    { doc: event.doc, ...(ticket ? { ticket } : {}) },
    actor,
    event.at,
    {
      docId: event.doc,
      title: event.title,
      url: event.url,
      ...event.data,
    },
  );
}

/**
 * Maps the `@name`s an adapter parsed out of a comment to the handles of the team's agents, by their tracker username,
 * handle or display name, in the order they were written. Names that are nobody on the team are dropped.
 */
export function agentMentionResolver(team: TeamConfig): (names: unknown) => string[] {
  const byName = new Map<string, string>();
  for (const p of team.people) {
    for (const name of [p.identities?.tracker, p.handle, p.name]) {
      if (name) {
        byName.set(name.toLowerCase(), p.handle);
      }
    }
  }

  return (names) => {
    const handles = Array.isArray(names)
      ? names.flatMap((n) => (typeof n === "string" ? [byName.get(n.toLowerCase())] : []))
      : [];

    return [...new Set(handles.filter((h): h is string => h !== undefined))];
  };
}

/** Replaces the names in `data.mentions` with agent handles, or removes them when nobody on the team is named. */
export function resolveMentions(
  event: WorkflowEvent,
  resolve: ((names: unknown) => string[]) | undefined,
): void {
  const handles = resolve && event.actor.kind === "human" ? resolve(event.data["mentions"]) : [];
  if (handles.length > 0) {
    event.data["mentions"] = handles;
  } else {
    delete event.data["mentions"];
  }
}
