import type { WorkflowEvent } from "@outstaff/core";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord } from "./workstate/index.js";

/** What an agent event on a work item is about: the ticket, or the pull request with its ticket. Nothing for other subjects. */
export async function itemEventSubject(
  store: Store,
  subject: NonNullable<WorkItem["subject"]>,
): Promise<WorkflowEvent["subject"] | undefined> {
  if (subject.type === "ticket") {
    return { ticket: subject.ref };
  }

  if (subject.type !== "pr") {
    return undefined;
  }

  const pr = (await store.getSubject("pr", subject.ref))?.data as PrRecord | undefined;
  return pr ? { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) } : undefined;
}
