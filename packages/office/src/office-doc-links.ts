import type { Logger } from "@outstaff/core";
import { ProtocolError, type DocLinks } from "./protocol/index.js";
import { itemTicket } from "./item-ticket.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

/**
 * Records which documents agents wrote for which ticket, for the protocol's `doc_link`. A document for a ticket is then
 * linked on it in the tracker (`doc.linked`).
 */
export function officeDocLinks(deps: {
  store: Store;
  workState: WorkState;
  log: Logger;
}): DocLinks {
  const { store, workState, log } = deps;
  // A document written while answering comments on another document is for that document's ticket.
  const ticketOf = async (item: WorkItem) =>
    item.subject?.type === "doc"
      ? workState.doc(item.subject.ref)?.ticket
      : await itemTicket(store, item);

  /** A ticket the agent named: one the office knows, read from the tracker if it is new. */
  const named = async (key: string) => {
    if (!workState.ticket(key)) {
      await workState.refreshTicket(key);
    }

    if (!workState.ticket(key)) {
      throw new ProtocolError("invalid", `No ticket ${key} is known to the office.`);
    }

    return key;
  };

  return {
    async link(person, workItemId, doc, explicit) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      const ticket = explicit ? await named(explicit) : await ticketOf(item);

      await workState.linkDoc({ ...doc, author: person, ...(ticket ? { ticket } : {}) });
      await store.addItemRefs(item.id, [
        { type: "doc", ref: doc.id, url: doc.url, role: "created", source: "doc_link" },
      ]);

      log.info(`doc ${doc.id} linked to ${ticket ?? "no ticket"} for ${person}`, {
        person,
        doc: doc.id,
      });
    },
  };
}
