import type { WorkflowEvent } from "@outstaff/core";
import type { Feedback } from "@outstaff/protocol";
import type { Store } from "../store/types.js";

/** The subject type that keeps the feedback that started a review round, keyed by work item id. */
export const FEEDBACK_SUBJECT = "work_feedback";

/** The review or comment a pull request event carries; nothing for other events. */
export function feedbackOf(event: WorkflowEvent): Feedback | undefined {
  const text = (key: string) => {
    const v = event.data[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };

  const url = text("url");
  const body = text("body") ?? "";
  const base = { actor: event.actor.id, body, ...(url ? { url } : {}) };
  if (event.type === "pr.review_submitted") {
    const state = text("state");
    return { ...base, kind: "review", ...(state ? { state } : {}) };
  }

  if (event.type === "pr.comment") {
    return { ...base, kind: event.data["kind"] === "comment" ? "comment" : "inline_comment" };
  }

  return undefined;
}

export async function readFeedback(
  store: Pick<Store, "getSubject">,
  itemId: string,
): Promise<Feedback | undefined> {
  return (await store.getSubject(FEEDBACK_SUBJECT, itemId))?.data as Feedback | undefined;
}
