import type { ItemRef, Store } from "#/store/types.js";
import type { DocRecord, WorkState } from "#/workstate/index.js";

/**
 * The documents a chat session wrote, attached with it to a ticket's work: each is recorded on the item that does the
 * work and becomes the ticket's document, which links it on the ticket in the tracker (`doc.linked`).
 */
export async function attachSessionDocs(
  deps: {
    store: Pick<Store, "listItemRefs" | "addItemRefs">;
    workState: Pick<WorkState, "doc" | "linkDoc">;
  },
  person: string,
  from: { sessionId: string; itemId: string; ticket: string | undefined },
): Promise<void> {
  const refs = (await deps.store.listItemRefs(from.sessionId)).filter((r) => r.type === "doc");
  if (!from.ticket || refs.length === 0) {
    return;
  }

  await deps.store.addItemRefs(
    from.itemId,
    refs.map((r) => ({
      type: "doc",
      ref: r.ref,
      url: r.url,
      role: "attached",
      source: "work_attach",
    })),
  );

  for (const ref of refs) {
    await deps.workState.linkDoc({
      ...docOf(ref, deps.workState.doc(ref.ref)),
      author: person,
      ticket: from.ticket,
    });
  }
}

/** A document as the work state knows it, else as its reference has it. */
const docOf = (ref: ItemRef, known: DocRecord | undefined) => ({
  id: ref.ref,
  title: known?.title ?? ref.ref,
  url: known?.url ?? ref.url ?? "",
});
