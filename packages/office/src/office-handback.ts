import type { Logger, WorkflowEvent } from "@outstaff/core";
import type { Engine } from "./engine/index.js";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

const handedBackText = (item: WorkItem) => `handed back ${item.id}`;

/** What follows an agent's hand-back of an item: an `agent.handed_back` event for its ticket or pull request. */
export function createHandedBack(deps: {
  store: Store;
  workState: WorkState;
  engine: Engine;
  log: Logger;
  track: <T>(p: Promise<T>) => Promise<T>;
}) {
  const { store, workState, engine, log, track } = deps;
  return async (item: WorkItem): Promise<void> => {
    if (
      (item.status !== "done" && item.status !== "waiting" && item.status !== "blocked") ||
      !item.subject
    ) {
      return;
    }

    // Answering comments on a document, or a question on a ticket someone else has, changes nothing on the ticket.
    // Trying to unblock a ticket is not a hand-back on it either: the ticket stays as it is.
    if (item.kind === "doc_feedback" || item.kind === "asked" || item.kind === "unblock") {
      return;
    }

    let subject: WorkflowEvent["subject"] | undefined;
    if (item.subject.type === "ticket") {
      subject = { ticket: item.subject.ref };
    } else if (item.subject.type === "pr") {
      const pr = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
      subject = pr ? { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) } : undefined;
    }

    if (!subject) {
      return;
    }

    const runs = await store.listRuns(item.id);
    const event: WorkflowEvent = {
      type: "agent.handed_back",
      subject,
      actor: { kind: "agent", id: item.person },
      data: { workItem: item.id, kind: item.kind, status: item.status },
    };

    // The rules read whether the ticket was handed back as done from the state, so it is refreshed first.
    await workState.refreshWorkers().catch((error: unknown) => {
      log.warn("refreshing who worked on what failed", { error: String(error) });
    });

    await track(
      engine.handle(event, {
        source: "workstate",
        externalId: `handed_back:${item.id}:${runs.at(-1)?.id ?? "0"}`,
        trusted: true,
      }),
    );

    log.info(handedBackText(item), { person: item.person });
  };
}
