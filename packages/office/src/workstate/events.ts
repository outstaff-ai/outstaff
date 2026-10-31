import type { PrRef, PrVerdict, WorkflowEvent } from "@outstaff/core";
import { awaitsReview } from "#/work-feedback.js";
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

const VERDICTS = new Set<string>(["approved", "changes_requested", "dismissed"]);

const isVerdict = (state: string): state is PrVerdict["state"] => VERDICTS.has(state);

/** The state a submitted review leaves on the pull request; a comment-only review leaves none. */
function reviewOf(event: WorkflowEvent): string | undefined {
  const state = event.data["state"];
  return event.type === "pr.review_submitted" && typeof state === "string" && state !== "commented"
    ? state
    : undefined;
}

/** A trusted reviewer's approval or request for changes replaces their earlier verdict. */
function verdictOf(event: WorkflowEvent, review: string | undefined): PrVerdict | undefined {
  if (!review || !isVerdict(review)) {
    return undefined;
  }

  return event.data["untrusted"] !== true && event.actor.kind !== "automation"
    ? { actor: event.actor.id, kind: event.actor.kind, state: review }
    : undefined;
}

/** Applies events to the records, and delivers the synthetic events that raises. */
export function createEvents(core: WorkstateCore, ops: TicketOps & PrOps & RequesterOps & DocOps) {
  const { store, logger, handlers, prSubject } = core;
  const {
    refreshPr,
    raiseBaseMerged,
    refreshTicket,
    recordFeedbackRequester,
    recordCommentRequester,
    touchDoc,
  } = ops;

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

  /** After a merge: every other open pull request of the repository is read again; one stacked on it lost its base. */
  const refreshSiblings = async (ctx: RefreshCtx, merged: PrRef) => {
    const done = core.prs.get(prSubject(merged));
    for (const other of openPrs(core, merged.repo)) {
      if (prSubject(other.ref) === prSubject(merged)) {
        continue;
      }

      await refreshPr(ctx, other.ref, { wait: true });
      const now = core.prs.get(prSubject(other.ref));
      if (done?.state === "merged" && now?.state === "open" && now.baseRef === done.headRef) {
        await raiseBaseMerged(ctx, now, done);
      }
    }
  };

  const onPr = async (ctx: RefreshCtx, event: WorkflowEvent) => {
    const pr = event.subject.pr;
    if (!pr) {
      return;
    }

    const review = reviewOf(event);
    const verdict = verdictOf(event, review);
    await refreshPr(ctx, pr, { ...(review ? { review } : {}), ...(verdict ? { verdict } : {}) });
    if (event.type === "pr.review_submitted" || event.type === "pr.comment") {
      await recordFeedbackRequester(event, pr);
    }

    if (event.type === "pr.merged") {
      await refreshSiblings(ctx, pr);
    }
  };

  const onTicket = async (_ctx: RefreshCtx, event: WorkflowEvent) => {
    const ticket = event.subject.ticket;
    if (!ticket) {
      return;
    }

    await refreshTicket(ticket, event);
    if (event.type === "ticket.commented") {
      await recordCommentRequester(ticket, event);
    }
  };

  const onDoc = async (_ctx: RefreshCtx, event: WorkflowEvent) => {
    if (event.subject.doc) {
      await touchDoc(event.subject.doc, event);
    }
  };

  // Our own synthetic events and the ones only the pipeline judges have no handler.
  const bySubject: Partial<Record<WorkflowEvent["type"], typeof onPr>> = {
    "pr.opened": onPr,
    "pr.comment": onPr,
    "pr.closed": onPr,
    "pr.merged": onPr,
    "pr.review_submitted": onPr,
    "ticket.created": onTicket,
    "ticket.assigned": onTicket,
    "ticket.moved": onTicket,
    "ticket.commented": onTicket,
    "doc.commented": onDoc,
  };

  const handle = async (ctx: RefreshCtx, event: WorkflowEvent) => {
    if (awaitsReview(event)) {
      return;
    }

    await bySubject[event.type]?.(ctx, event);
  };

  return { deliver, handle };
}
