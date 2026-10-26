import type { Logger } from "@outstaff/core";
import type { TicketPrs } from "./protocol/index.js";
import type { WorkState } from "./workstate/index.js";

/** Answers the protocol's `ticket_prs` from the work state. */
export function officeTicketPrs(deps: { workState: WorkState; log: Logger }): TicketPrs {
  const { workState, log } = deps;
  return {
    async forDraft(draft) {
      // A pull request opened a moment ago may not have reached the state yet; the answer must not depend on that.
      await workState.catchUp().catch((error: unknown) => {
        log.warn("could not look for new pull requests", { error: String(error) });
      });

      const ticket = await workState.ticketForDraft({
        headRef: draft.headRef,
        title: draft.title,
        body: draft.body,
      });

      return {
        ...(ticket ? { ticket } : {}),
        prs: ticket
          ? workState
              .prsOfTicket(ticket)
              .toSorted((a, b) => a.ref.number - b.ref.number)
              .map((p) => ({
                ref: workState.prSubject(p.ref),
                number: p.ref.number,
                title: p.title,
                ...(p.url ? { url: p.url } : {}),
                state: p.state,
                authorKind: p.author.kind,
              }))
          : [],
      };
    },
  };
}
