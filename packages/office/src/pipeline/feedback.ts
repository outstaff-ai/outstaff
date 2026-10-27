import type { Feedback } from "@outstaff/protocol";
import { feedbackOf } from "#/engine/feedback.js";
import type { PipelineEvent } from "./events.types.js";

/** What a woken agent is shown of the event: the review, comment or chat message it carries. */
export function feedbackFor(event: PipelineEvent): Feedback[] {
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
