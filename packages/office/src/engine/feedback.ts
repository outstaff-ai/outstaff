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
    const comments = event.data["comments"];
    return {
      ...base,
      kind: "review",
      ...(state ? { state } : {}),
      ...(Array.isArray(comments) && comments.length > 0
        ? { comments: comments as NonNullable<Feedback["comments"]> }
        : {}),
    };
  }

  if (event.type === "pr.comment") {
    return { ...base, kind: event.data["kind"] === "comment" ? "comment" : "inline_comment" };
  }

  return undefined;
}

/**
 * An inline comment of a review, announced by the host while the review is still pending. Nobody else can see it
 * yet; the submitted review brings it along, so it neither schedules work nor changes the work state.
 */
export function awaitsReview(event: WorkflowEvent): boolean {
  return (
    event.type === "pr.comment" &&
    event.data["kind"] === "review_comment" &&
    event.data["reviewId"] !== undefined
  );
}

export async function readFeedback(
  store: Pick<Store, "getSubject">,
  itemId: string,
): Promise<Feedback | undefined> {
  return (await store.getSubject(FEEDBACK_SUBJECT, itemId))?.data as Feedback | undefined;
}
