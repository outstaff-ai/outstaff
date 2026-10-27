import type { PrVerdict, WorkflowEvent } from "@outstaff/core";
import { awaitsReview } from "../engine/feedback.js";
import type {
  DocOps,
  Fresh,
  PrOps,
  RefreshCtx,
  RequesterOps,
  TicketOps,
  WorkstateCore,
} from "./core.types.js";
import { openPrs } from "./derive.js";

/** Applies events to the records, and delivers the synthetic events that raises. */
export function createEvents(core: WorkstateCore, ops: TicketOps & PrOps & RequesterOps & DocOps) {
  const { store, logger, handlers, prSubject } = core;
  const { refreshPr, refreshTicket, recordFeedbackRequester, recordCommentRequester, touchDoc } =
    ops;

  const deliver = async (list: Fresh[]) => {
    if (handlers.length === 0) {
      return;
    }

    for (const { event, externalId } of list) {
      let ok = true;
      for (const handler of handlers) {
        try {
          await handler(event, { source: "workstate", externalId, trusted: true });
        } catch (error) {
          ok = false;
          logger.warn("workstate handler failed", { type: event.type, error: String(error) });
        }
      }

      if (ok) {
        await store.markProcessed("workstate", externalId);
      }
    }
  };

  const handle = async (ctx: RefreshCtx, event: WorkflowEvent) => {
    if (awaitsReview(event)) {
      return;
    }

    const pr = event.subject.pr;
    switch (event.type) {
      case "pr.opened":
      case "pr.comment":
      case "pr.closed":
      case "pr.merged":
      case "pr.review_submitted": {
        if (!pr) {
          return;
        }

        const state = event.data["state"];
        const review =
          event.type === "pr.review_submitted" && typeof state === "string" && state !== "commented"
            ? state
            : undefined;

        // A trusted reviewer's approval or request for changes replaces their earlier verdict.
        const verdict: PrVerdict | undefined =
          review &&
          (review === "approved" || review === "changes_requested" || review === "dismissed") &&
          event.data["untrusted"] !== true &&
          event.actor.kind !== "automation"
            ? { actor: event.actor.id, kind: event.actor.kind, state: review }
            : undefined;

        await refreshPr(ctx, pr, {
          ...(review ? { review } : {}),
          ...(verdict ? { verdict } : {}),
        });

        if (event.type === "pr.review_submitted" || event.type === "pr.comment") {
          await recordFeedbackRequester(event, pr);
        }

        if (event.type === "pr.merged") {
          for (const other of openPrs(core, pr.repo)) {
            if (prSubject(other.ref) !== prSubject(pr)) {
              await refreshPr(ctx, other.ref, { wait: true });
            }
          }
        }

        return;
      }

      case "ticket.created":
      case "ticket.assigned":
      case "ticket.moved":
      case "ticket.commented":
        if (event.subject.ticket) {
          await refreshTicket(event.subject.ticket, event);
          if (event.type === "ticket.commented") {
            await recordCommentRequester(event.subject.ticket, event);
          }
        }

        return;
      case "doc.commented":
        if (event.subject.doc) {
          await touchDoc(event.subject.doc, event);
        }

        return;
      default:
        // Our own synthetic events and the ones for the engine only.
        return;
    }
  };

  return { deliver, handle };
}
