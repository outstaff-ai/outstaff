import type { ConditionEvent } from "@outstaff/core";
import type { Feedback } from "@outstaff/protocol";
import type { Store } from "../store/types.js";

/**
 * The subject type that keeps the feedback of a review round, keyed by work item id: a list, because feedback that
 * arrives while the item is queued or running is attached to it. Only the engine writes it.
 */
export const FEEDBACK_SUBJECT = "work_feedback";

/** How many of the item's feedback entries went out in an offer, so what came later is known. Only the work source writes it. */
export const DELIVERED_SUBJECT = "work_feedback_delivered";

/** Set once the follow-up round for an item's late feedback is queued, so a repeated hand-back adds no second one. */
export const FOLLOW_UP_SUBJECT = "work_feedback_followup";

/** The review or comment a pull request, ticket or document event carries; nothing for other events. */
export function feedbackOf(event: ConditionEvent): Feedback | undefined {
  const text = (key: string) => {
    const v = event.data[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };

  const url = text("url");
  const at = text("at");
  const body = text("body") ?? "";
  const rawId = event.data["commentId"];
  const commentId =
    typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;

  const base = { actor: event.actor.id, body, ...(url ? { url } : {}), ...(at ? { at } : {}) };
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

  if (event.type === "doc.commented") {
    const docId = text("docId") ?? event.subject.doc;
    const anchor = text("anchorText");
    return {
      ...base,
      kind: "doc_comment",
      ...(docId ? { docId } : {}),
      ...(anchor ? { anchorText: anchor } : {}),
      ...(commentId ? { commentId } : {}),
    };
  }

  if (event.type === "pr.ci_failed") {
    const failed = event.data["checks"];
    const lines = Array.isArray(failed)
      ? failed.flatMap((c: { name?: unknown; url?: unknown; summary?: unknown }) =>
          typeof c.name === "string"
            ? [
                `${c.name}${typeof c.url === "string" ? ` (${c.url})` : ""}${typeof c.summary === "string" && c.summary !== "" ? `: ${c.summary}` : ""}`,
              ]
            : [],
        )
      : [];

    return { ...base, kind: "ci_failure", body: lines.join("\n") };
  }

  if (event.type === "ticket.commented") {
    return { ...base, kind: "ticket_comment", ...(commentId ? { commentId } : {}) };
  }

  if (event.type === "pr.comment") {
    return {
      ...base,
      kind: event.data["kind"] === "comment" ? "comment" : "inline_comment",
      ...(commentId ? { commentId } : {}),
    };
  }

  return undefined;
}

/**
 * An inline comment of a review, announced by the host while the review is still pending. Nobody else can see it
 * yet; the submitted review brings it along, so it neither schedules work nor changes the work state.
 */
export function awaitsReview(event: ConditionEvent): boolean {
  return (
    event.type === "pr.comment" &&
    event.data["kind"] === "review_comment" &&
    event.data["reviewId"] !== undefined
  );
}

type Reader = Pick<Store, "getSubject">;

/** In the order it arrived; what an offer carried is a count of this list. */
const arrived = async (store: Reader, itemId: string): Promise<Feedback[]> =>
  ((await store.getSubject(FEEDBACK_SUBJECT, itemId))?.data as Feedback[] | undefined) ?? [];

/** Oldest first by the time the host reported it; ids and arrival order only break ties. */
const byTime = (list: Feedback[]) =>
  list.toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

export async function readFeedback(store: Reader, itemId: string): Promise<Feedback[]> {
  return byTime(await arrived(store, itemId));
}

export async function addFeedback(
  store: Reader & Pick<Store, "upsertSubject">,
  itemId: string,
  feedback: Feedback,
): Promise<void> {
  await store.upsertSubject(FEEDBACK_SUBJECT, itemId, [
    ...(await arrived(store, itemId)),
    feedback,
  ]);
}

/** Reads the feedback for an offer and records how much of it that was. */
export async function deliverFeedback(
  store: Reader & Pick<Store, "upsertSubject">,
  itemId: string,
): Promise<Feedback[]> {
  const list = await arrived(store, itemId);
  await store.upsertSubject(DELIVERED_SUBJECT, itemId, { count: list.length });
  return byTime(list);
}

/** What was attached to the item after its last offer. */
export async function undeliveredFeedback(store: Reader, itemId: string): Promise<Feedback[]> {
  const count =
    ((await store.getSubject(DELIVERED_SUBJECT, itemId))?.data as { count: number } | undefined)
      ?.count ?? 0;

  return byTime((await arrived(store, itemId)).slice(count));
}
