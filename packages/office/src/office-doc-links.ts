import type { Logger } from "@outstaff/core";
import { ProtocolError, type DocLinks } from "./protocol/index.js";
import type { Store } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

/** Records which documents agents wrote for which ticket, for the protocol's `doc_link`. */
export function officeDocLinks(deps: {
  store: Store;
  workState: WorkState;
  log: Logger;
}): DocLinks {
  const { store, workState, log } = deps;
  return {
    async link(person, workItemId, doc) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      let ticket: string | undefined;
      if (item.subject?.type === "ticket") {
        ticket = item.subject.ref;
      } else if (item.subject?.type === "pr") {
        ticket = ((await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined)
          ?.ticket;
      } else if (item.subject?.type === "doc") {
        ticket = workState.doc(item.subject.ref)?.ticket;
      }

      await workState.linkDoc({ ...doc, author: person, ...(ticket ? { ticket } : {}) });
      log.info(`doc ${doc.id} linked to ${ticket ?? "no ticket"} for ${person}`, {
        person,
        doc: doc.id,
      });
    },
  };
}
