import type { Feedback } from "@outstaff/protocol";
import { feedbackOf } from "#/work-feedback.js";
import type { PipelineEvent } from "@outstaff/policy";

/** A hand-back as blocked: what the blocked agent handed back, for the teammate woken to unblock it. */
function blockedHandBack(event: PipelineEvent): Feedback[] {
  const summary = event.data["summary"];
  return event.data["status"] === "blocked" && typeof summary === "string"
    ? [{ actor: event.actor.id, kind: "blocked", body: summary, at: event.at }]
    : [];
}

/**
 * What a woken agent is shown of the event: the review, comment or chat message it carries, or what an agent handed
 * back as blocked.
 */
export function feedbackFor(event: PipelineEvent): Feedback[] {
  if (event.type === "agent.handed_back") {
    return blockedHandBack(event);
  }

  if (event.type === "chat.message") {
    const body = event.data["body"];
    const url = event.data["url"];
    return [
      {
        actor: event.actor.id,
        kind: "chat",
        body: typeof body === "string" ? body : "",
        at: event.at,
        ...(typeof url === "string" ? { url } : {}),
      },
    ];
  }

  const found = feedbackOf(event);
  return found ? [found] : [];
}
