import type { Logger, TeamConfig } from "@outstaff/core";
import { officeTicketPrs } from "./office-ticket-prs.js";
import { ProtocolError, type TicketPrs, type WorkMade } from "./protocol/index.js";
import type { NewItemRef, Store } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

/** What an item records for the ticket its agent created (`ost ticket create`). */
export const TICKET_CREATE_SOURCE = "ticket_create";

/** What an item records for a pull request its agent opened (`ost pr open`), and for that pull request's ticket. */
export const PR_OPEN_SOURCE = "pr_open";

const repoOf = ({ host, ...repo }: { owner: string; name: string; host?: string | undefined }) =>
  host ? { ...repo, host } : repo;

/**
 * Records what agents made in their work items, for the protocol's `work_made`: a ticket created is the item's
 * (`created`), and so is a pull request opened, with the ticket it links to as the office worked it out (`inferred`).
 * A hand-back reads them back to give those tickets to the requester too.
 */
export function officeWorkMade(deps: {
  store: Store;
  workState: WorkState;
  log: Logger;
}): WorkMade {
  const { store, workState, log } = deps;
  return {
    async made(person, { workItemId, ticket, pr }) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      const refs: NewItemRef[] = pr
        ? [
            {
              type: "pr",
              ref: workState.prSubject({ repo: repoOf(pr.repo), number: pr.number }),
              url: pr.url,
              role: "created",
              source: PR_OPEN_SOURCE,
            },
            ...(ticket
              ? [
                  {
                    type: "ticket" as const,
                    ref: ticket,
                    role: "inferred" as const,
                    source: PR_OPEN_SOURCE,
                  },
                ]
              : []),
          ]
        : ticket
          ? [{ type: "ticket", ref: ticket, role: "created", source: TICKET_CREATE_SOURCE }]
          : [];

      await store.addItemRefs(item.id, refs);
      // The pull request was opened a moment ago: take it in now, so the item's hand-back knows its ticket.
      if (pr) {
        await workState.catchUp().catch((error: unknown) => {
          log.warn("could not look for new pull requests", { error: String(error) });
        });
      }

      log.info(`${person} made ${refs.map((r) => r.ref).join(", ") || "nothing"} in ${item.id}`, {
        person,
      });
    },
  };
}

/** The office's desks for tickets and pull requests: which ticket a pull request links to, and what agents made. */
export function officeTicketDesks(deps: {
  store: Store;
  workState: WorkState;
  team: TeamConfig;
  log: Logger;
}): { tickets: TicketPrs; made: WorkMade } {
  return { tickets: officeTicketPrs(deps), made: officeWorkMade(deps) };
}
