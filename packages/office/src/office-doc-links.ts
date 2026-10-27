import type { Logger } from "@outstaff/core";
import { ProtocolError, type DocLinks } from "./protocol/index.js";
import { itemTicket } from "./item-ticket.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

/** Records which documents agents wrote for which ticket, for the protocol's `doc_link`. */
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

  return {
    async link(person, workItemId, doc) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      const ticket = await ticketOf(item);

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
